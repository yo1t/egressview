using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace EgressView.Agent.Core;

public sealed record AgentUpdatePackage(string Arch, string PackageType, Uri Url, string Sha256, long SizeBytes, string? Publisher);
public sealed record AgentUpdateManifest(int SchemaVersion, string Platform, string Version, DateTimeOffset ReleasedAt, IReadOnlyList<AgentUpdatePackage> Packages);
public sealed record AgentUpdateCandidate(string Version, AgentUpdatePackage Package, string UserAgent);
public sealed record VerifiedAgentUpdate(string Version, string Path, string Publisher, long SizeBytes, string Sha256);

public enum AgentUpdateDecisionKind { UpToDate, UpdateAvailable }
public sealed record AgentUpdateDecision(AgentUpdateDecisionKind Kind, string PublishedVersion, AgentUpdateCandidate? Candidate);

public readonly record struct AgentSemanticVersion(int Major, int Minor, int Patch, string? Prerelease) : IComparable<AgentSemanticVersion>
{
    public static bool TryParse(string? text, out AgentSemanticVersion result)
    {
        result = default;
        if (string.IsNullOrWhiteSpace(text)) return false;
        var parts = text.Split('-', 2);
        var numbers = parts[0].Split('.');
        if (numbers.Length != 3 || !int.TryParse(numbers[0], out var major) || !int.TryParse(numbers[1], out var minor) ||
            !int.TryParse(numbers[2], out var patch) || major < 0 || minor < 0 || patch < 0) return false;
        var prerelease = parts.Length == 2 && parts[1].Length > 0 ? parts[1] : null;
        result = new(major, minor, patch, prerelease);
        return true;
    }

    public int CompareTo(AgentSemanticVersion other)
    {
        var value = Major.CompareTo(other.Major);
        if (value != 0) return value;
        value = Minor.CompareTo(other.Minor);
        if (value != 0) return value;
        value = Patch.CompareTo(other.Patch);
        if (value != 0) return value;
        if (Prerelease is null) return other.Prerelease is null ? 0 : 1;
        if (other.Prerelease is null) return -1;
        return string.CompareOrdinal(Prerelease, other.Prerelease);
    }
}

public static class AgentReleaseKey
{
    public const string Identifier = "egressview-release-2026";
    public const string PublishedFingerprint = "SHA256:6288265bd746d230a3637e3a520e2335f48dc939a4d76d7b05c44ea5baf3eccc";
    private static readonly byte[] RawKey = Convert.FromBase64String("jLUS+Q2VoyonFtVcv2Z2cnKf6e0sjC9S+9scCg26BU8=");
    private static readonly byte[] SpkiHeader = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

    public static string Fingerprint => $"SHA256:{Convert.ToHexStringLower(SHA256.HashData([.. SpkiHeader, .. RawKey]))}";
    public static bool MatchesPublishedFingerprint => string.Equals(Fingerprint, PublishedFingerprint, StringComparison.Ordinal);

    public static bool Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature)
    {
        if (!MatchesPublishedFingerprint || signature.Length != 64) return false;
        var verifier = new Ed25519Signer();
        verifier.Init(false, new Ed25519PublicKeyParameters(RawKey));
        var bytes = message.ToArray();
        verifier.BlockUpdate(bytes, 0, bytes.Length);
        return verifier.VerifySignature(signature.ToArray());
    }
}

public sealed class WindowsAgentUpdateClient : IDisposable
{
    public static readonly Uri DefaultOrigin = new("https://dl.egressview.com/");
    private const int MaximumManifestBytes = 4096;
    private const long MaximumPackageBytes = 2L * 1024 * 1024 * 1024;
    private readonly HttpClient http;
    private readonly Uri origin;
    private readonly IWindowsPackageVerifier verifier;
    private readonly IAgentManifestVerifier manifestVerifier;

    public WindowsAgentUpdateClient(HttpMessageHandler? handler = null, Uri? origin = null, IWindowsPackageVerifier? verifier = null, IAgentManifestVerifier? manifestVerifier = null)
    {
        this.origin = origin ?? DefaultOrigin;
        if (this.origin.Scheme != Uri.UriSchemeHttps) throw new ArgumentException("Update origin must use HTTPS.", nameof(origin));
        this.verifier = verifier ?? new WindowsAuthenticodeVerifier();
        this.manifestVerifier = manifestVerifier ?? new EmbeddedAgentManifestVerifier();
        http = handler is null
            ? new HttpClient(new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
            : new HttpClient(handler, disposeHandler: false);
        http.Timeout = TimeSpan.FromMinutes(5);
    }

    public static string CurrentVersion => Assembly.GetEntryAssembly()?.GetName().Version?.ToString(3) ?? "0.0.0";
    public static string HostArch => RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "arm64" : "x64";
    public static string UserAgent(string version, string osVersion) => $"EgressViewAgent/{version} (Windows {osVersion})";

    public async Task<AgentUpdateDecision> CheckAsync(string currentVersion, string osVersion, CancellationToken cancellationToken = default)
    {
        if (!AgentReleaseKey.MatchesPublishedFingerprint) throw new InvalidDataException("embedded-key-not-published");
        var userAgent = UserAgent(currentVersion, osVersion);
        var manifestBytes = await GetBoundedAsync(new Uri(origin, "windows/manifest.json"), MaximumManifestBytes, userAgent, cancellationToken);
        var signature = await GetBoundedAsync(new Uri(origin, "windows/manifest.json.sig"), 64, userAgent, cancellationToken);
        if (!manifestVerifier.Verify(manifestBytes, signature)) throw new CryptographicException("manifest-signature-invalid");
        var manifest = JsonSerializer.Deserialize<AgentUpdateManifest>(manifestBytes, new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidDataException("manifest-malformed");
        if (manifest.SchemaVersion != 1) throw new InvalidDataException("manifest-schema-unsupported");
        if (!string.Equals(manifest.Platform, "windows", StringComparison.Ordinal)) throw new InvalidDataException("manifest-platform-mismatch");
        if (!AgentSemanticVersion.TryParse(manifest.Version, out var published) || !AgentSemanticVersion.TryParse(currentVersion, out var installed))
            throw new InvalidDataException("manifest-version-invalid");
        if (published.CompareTo(installed) <= 0) return new(AgentUpdateDecisionKind.UpToDate, manifest.Version, null);
        var package = manifest.Packages.SingleOrDefault(item => string.Equals(item.Arch, HostArch, StringComparison.Ordinal));
        ValidatePackage(package);
        return new(AgentUpdateDecisionKind.UpdateAvailable, manifest.Version, new(manifest.Version, package!, userAgent));
    }

    public async Task<VerifiedAgentUpdate> DownloadAndVerifyAsync(AgentUpdateCandidate candidate, string directory, CancellationToken cancellationToken = default)
    {
        ValidatePackage(candidate.Package);
        Directory.CreateDirectory(directory);
        var final = Path.Combine(directory, $"EgressView-Agent-Windows-{candidate.Version}-{candidate.Package.Arch}.msi");
        var temporary = $"{final}.tmp-{Guid.NewGuid():N}";
        try
        {
            using var request = CreateRequest(candidate.Package.Url, candidate.UserAgent);
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (response.StatusCode != HttpStatusCode.OK) throw new HttpRequestException($"package-http-{(int)response.StatusCode}");
            if (response.Content.Headers.ContentLength is { } length && length != candidate.Package.SizeBytes) throw new InvalidDataException("package-size-mismatch");
            await using (var source = await response.Content.ReadAsStreamAsync(cancellationToken))
            await using (var destination = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 20, FileOptions.Asynchronous | FileOptions.SequentialScan))
            {
                var buffer = new byte[1 << 20];
                long total = 0;
                int read;
                while ((read = await source.ReadAsync(buffer, cancellationToken)) > 0)
                {
                    total = checked(total + read);
                    if (total > candidate.Package.SizeBytes || total > MaximumPackageBytes) throw new InvalidDataException("package-size-mismatch");
                    await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                }
                if (total != candidate.Package.SizeBytes) throw new InvalidDataException("package-size-mismatch");
                await destination.FlushAsync(cancellationToken);
            }
            var actualHash = await Sha256Async(temporary, cancellationToken);
            if (!string.Equals(actualHash, candidate.Package.Sha256, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("package-sha256-mismatch");
            var publisher = verifier.Verify(temporary, candidate.Package.Publisher!);
            File.Move(temporary, final, true);
            return new(candidate.Version, final, publisher, candidate.Package.SizeBytes, actualHash);
        }
        catch
        {
            try { File.Delete(temporary); } catch { }
            throw;
        }
    }

    public async Task ReverifyAsync(VerifiedAgentUpdate update, CancellationToken cancellationToken = default)
    {
        var file = new FileInfo(update.Path);
        if (!file.Exists || file.Length != update.SizeBytes) throw new InvalidDataException("package-size-mismatch");
        var actualHash = await Sha256Async(update.Path, cancellationToken);
        if (!string.Equals(actualHash, update.Sha256, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("package-sha256-mismatch");
        _ = verifier.Verify(update.Path, update.Publisher);
    }

    private void ValidatePackage(AgentUpdatePackage? package)
    {
        if (package is null) throw new InvalidDataException("package-arch-unavailable");
        if (!string.Equals(package.PackageType, "msi", StringComparison.Ordinal) || package.Url.Scheme != Uri.UriSchemeHttps ||
            !string.Equals(package.Url.Host, origin.Host, StringComparison.OrdinalIgnoreCase) || package.Url.Port != origin.Port)
            throw new InvalidDataException("package-url-invalid");
        if (package.SizeBytes is <= 0 or > MaximumPackageBytes) throw new InvalidDataException("package-size-invalid");
        if (package.Sha256.Length != 64 || package.Sha256.Any(value => !Uri.IsHexDigit(value))) throw new InvalidDataException("package-sha256-invalid");
        if (string.IsNullOrWhiteSpace(package.Publisher) || package.Publisher.Length > 200) throw new InvalidDataException("package-publisher-invalid");
    }

    private async Task<byte[]> GetBoundedAsync(Uri url, int limit, string userAgent, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(url, userAgent);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode != HttpStatusCode.OK) throw new HttpRequestException($"manifest-http-{(int)response.StatusCode}");
        if (response.Content.Headers.ContentLength is { } contentLength && contentLength > limit) throw new InvalidDataException("response-too-large");
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var output = new MemoryStream();
        var buffer = new byte[1024];
        int read;
        while ((read = await stream.ReadAsync(buffer, cancellationToken)) > 0)
        {
            if (output.Length + read > limit) throw new InvalidDataException("response-too-large");
            output.Write(buffer, 0, read);
        }
        return output.ToArray();
    }

    private static HttpRequestMessage CreateRequest(Uri url, string userAgent)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.UserAgent.ParseAdd(userAgent);
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true };
        return request;
    }

    internal static async Task<string> Sha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20, FileOptions.Asynchronous | FileOptions.SequentialScan);
        return Convert.ToHexStringLower(await SHA256.HashDataAsync(stream, cancellationToken));
    }

    public void Dispose() => http.Dispose();
}

public interface IAgentManifestVerifier
{
    bool Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature);
}

public sealed class EmbeddedAgentManifestVerifier : IAgentManifestVerifier
{
    public bool Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature) => AgentReleaseKey.Verify(message, signature);
}

public interface IWindowsPackageVerifier
{
    string Verify(string path, string expectedPublisher);
}

public sealed class WindowsAuthenticodeVerifier : IWindowsPackageVerifier
{
    public string Verify(string path, string expectedPublisher)
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException();
        if (WinTrust.VerifyEmbeddedSignature(path) != 0) throw new CryptographicException("package-authenticode-invalid");
#pragma warning disable SYSLIB0057 // Authenticode signer extraction has no X509CertificateLoader equivalent.
        using var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
        var publisher = certificate.GetNameInfo(X509NameType.SimpleName, false);
        if (string.IsNullOrWhiteSpace(publisher) || !publisher.Contains(expectedPublisher, StringComparison.OrdinalIgnoreCase))
            throw new CryptographicException("package-publisher-mismatch");
        return publisher;
    }
}

internal static partial class WinTrust
{
    private static readonly Guid ActionGenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    private const uint UiNone = 2;
    private const uint RevokeWholeChain = 1;
    private const uint ChoiceFile = 1;
    private const uint StateVerify = 1;
    private const uint StateClose = 2;
    private const uint RevocationCheckChainExcludeRoot = 0x80;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileInfo { public uint Size; public string Path; public nint File; public nint KnownSubject; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Data
    {
        public uint Size; public nint PolicyCallbackData; public nint SipClientData; public uint UiChoice;
        public uint RevocationChecks; public uint UnionChoice; public nint FileInfo; public uint StateAction;
        public nint StateData; public string? UrlReference; public uint ProviderFlags; public uint UiContext;
    }

    internal static int VerifyEmbeddedSignature(string path)
    {
        var file = new FileInfo { Size = (uint)Marshal.SizeOf<FileInfo>(), Path = path };
        var filePointer = Marshal.AllocHGlobal(Marshal.SizeOf<FileInfo>());
        try
        {
            Marshal.StructureToPtr(file, filePointer, false);
            var data = new Data
            {
                Size = (uint)Marshal.SizeOf<Data>(), UiChoice = UiNone, RevocationChecks = RevokeWholeChain,
                UnionChoice = ChoiceFile, FileInfo = filePointer, StateAction = StateVerify,
                ProviderFlags = RevocationCheckChainExcludeRoot,
            };
            var result = WinVerifyTrust(0, ActionGenericVerifyV2, ref data);
            data.StateAction = StateClose;
            _ = WinVerifyTrust(0, ActionGenericVerifyV2, ref data);
            return result;
        }
        finally { Marshal.FreeHGlobal(filePointer); }
    }

    [DllImport("wintrust.dll", EntryPoint = "WinVerifyTrust", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int WinVerifyTrust(nint window, in Guid action, ref Data data);
}
