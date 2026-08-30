using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace EgressView.Agent.Core;

public sealed class WindowsCredentialStore
{
    private const string Target = "EgressView.Agent.HubCredential";
    private const int Generic = 1;
    private const int PersistLocalMachine = 2;

    public void Save(AgentCredential credential)
    {
        if (!AgentEnrollmentClient.IsValidCredential(credential)) throw new ArgumentException("Invalid Agent credential.", nameof(credential));
        var bytes = JsonSerializer.SerializeToUtf8Bytes(credential);
        var blob = Marshal.AllocHGlobal(bytes.Length);
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var native = new NativeCredential
            {
                Type = Generic, TargetName = Target, CredentialBlobSize = bytes.Length,
                CredentialBlob = blob, Persist = PersistLocalMachine, UserName = credential.AgentId.ToString("D"),
            };
            if (!CredWrite(ref native, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
            Marshal.Copy(new byte[bytes.Length], 0, blob, bytes.Length);
            Marshal.FreeHGlobal(blob);
        }
    }

    public AgentCredential? Load()
    {
        if (!CredRead(Target, Generic, 0, out var pointer))
        {
            var error = Marshal.GetLastWin32Error();
            if (error == 1168) return null;
            throw new Win32Exception(error);
        }
        try
        {
            var native = Marshal.PtrToStructure<NativeCredential>(pointer);
            var bytes = new byte[native.CredentialBlobSize];
            Marshal.Copy(native.CredentialBlob, bytes, 0, bytes.Length);
            try
            {
                var credential = JsonSerializer.Deserialize<AgentCredential>(bytes);
                return credential is not null && AgentEnrollmentClient.IsValidCredential(credential)
                    ? credential : throw new InvalidDataException("Stored Agent credential is invalid.");
            }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        finally { CredFree(pointer); }
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
    [DllImport("advapi32.dll")] private static extern void CredFree(nint credential);
}
