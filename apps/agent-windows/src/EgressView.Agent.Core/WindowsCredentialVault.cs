using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace EgressView.Agent.Core;

/// Windows Credential Manager, for the two secrets this Agent holds.
///
/// The Hub credential and the MaxMind licence key have nothing to do with each
/// other, but they are kept the same way -- machine-persisted, readable only by
/// the service account -- and the careful part is identical: the plaintext is
/// zeroed on the way out of both managed and unmanaged memory. Writing that
/// twice is how one of the two copies quietly stops doing it.
internal static class WindowsCredentialVault
{
    private const int Generic = 1;
    private const int PersistLocalMachine = 2;
    private const int NotFound = 1168;

    internal static void Write(string target, string userName, byte[] secret)
    {
        var blob = Marshal.AllocHGlobal(secret.Length);
        try
        {
            Marshal.Copy(secret, 0, blob, secret.Length);
            var native = new NativeCredential
            {
                Type = Generic, TargetName = target, CredentialBlobSize = secret.Length,
                CredentialBlob = blob, Persist = PersistLocalMachine, UserName = userName,
            };
            if (!CredWrite(ref native, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secret);
            Marshal.Copy(new byte[secret.Length], 0, blob, secret.Length);
            Marshal.FreeHGlobal(blob);
        }
    }

    /// <returns>Null when nothing is stored, which is an ordinary state.</returns>
    internal static T? Read<T>(string target, Func<string, byte[], T?> decode) where T : class
    {
        if (!CredRead(target, Generic, 0, out var pointer))
        {
            var error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Win32Exception(error);
        }
        try
        {
            var native = Marshal.PtrToStructure<NativeCredential>(pointer);
            var bytes = new byte[native.CredentialBlobSize];
            Marshal.Copy(native.CredentialBlob, bytes, 0, bytes.Length);
            try { return decode(native.UserName ?? string.Empty, bytes); }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        finally { CredFree(pointer); }
    }

    internal static void Delete(string target)
    {
        if (CredDelete(target, Generic, 0)) return;
        var error = Marshal.GetLastWin32Error();
        if (error != NotFound) throw new Win32Exception(error);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        public int Flags; public int Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Comment;
        public long LastWritten; public int CredentialBlobSize; public nint CredentialBlob; public int Persist;
        public int AttributeCount; public nint Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string? TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredWrite(ref NativeCredential credential, int flags);
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredRead(string target, int type, int flags, out nint credential);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CredDelete(string target, int type, int flags);
    [DllImport("advapi32.dll")] private static extern void CredFree(nint credential);
}
