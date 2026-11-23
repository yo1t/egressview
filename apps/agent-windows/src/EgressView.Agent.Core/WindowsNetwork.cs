using System.Runtime.InteropServices;

namespace EgressView.Agent.Core;

/// What Windows itself says about this PC's network, in the words a notice
/// can use.
///
/// On 2026-11-21 the notice said only that delivery to the Hub was not
/// completing. The PC had lost its network after an update restart: Windows
/// had marked the main adapter as having no internet (an ARP probe to the
/// router failed) a minute and a half before the notice. The person had no way
/// to tell that from a Hub that was down.
public enum PcNetwork { Unknown, None, LocalOnly, Internet }

public static class WindowsNetwork
{
    /// Windows' own judgment, through the Network List Manager (the source of
    /// the network icon in the taskbar). Unknown if it cannot be asked.
    public static PcNetwork Read()
    {
        object? manager = null;
        try
        {
            var type = Type.GetTypeFromCLSID(new Guid("DCB00C01-570F-4A9B-8D69-199FDBA5723B"), throwOnError: false);
            if (type is null) return PcNetwork.Unknown;
            manager = Activator.CreateInstance(type);
            if (manager is not INetworkListManager list) return PcNetwork.Unknown;
            return Classify(list.GetConnectivity());
        }
        catch (COMException) { return PcNetwork.Unknown; }
        catch (InvalidCastException) { return PcNetwork.Unknown; }
        finally { if (manager is not null && Marshal.IsComObject(manager)) Marshal.ReleaseComObject(manager); }
    }

    /// NLM_CONNECTIVITY: either family reaching the internet is enough;
    /// reaching only the local subnet or link is "local only"; nothing at
    /// all, or only "no traffic", is none.
    public static PcNetwork Classify(int connectivity)
    {
        const int Ipv4Internet = 0x40, Ipv6Internet = 0x400;
        const int Ipv4Local = 0x20 | 0x10, Ipv6Local = 0x200 | 0x100;
        if ((connectivity & (Ipv4Internet | Ipv6Internet)) != 0) return PcNetwork.Internet;
        if ((connectivity & (Ipv4Local | Ipv6Local)) != 0) return PcNetwork.LocalOnly;
        return PcNetwork.None;
    }

    public static string Code(PcNetwork value) => value switch
    {
        PcNetwork.None => "none",
        PcNetwork.LocalOnly => "local-only",
        PcNetwork.Internet => "internet",
        _ => "unknown",
    };

    public static PcNetwork Parse(string? code) => code switch
    {
        "none" => PcNetwork.None,
        "local-only" => PcNetwork.LocalOnly,
        "internet" => PcNetwork.Internet,
        _ => PcNetwork.Unknown,
    };

    // netlistmgr.idl, in vtable order. Only GetConnectivity is called; the
    // others hold their places.
    [ComImport, Guid("DCB00000-570F-4A9B-8D69-199FDBA5723B"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    private interface INetworkListManager
    {
        [return: MarshalAs(UnmanagedType.IUnknown)] object GetNetworks(int flags);
        [return: MarshalAs(UnmanagedType.IUnknown)] object GetNetwork(Guid networkId);
        [return: MarshalAs(UnmanagedType.IUnknown)] object GetNetworkConnections();
        [return: MarshalAs(UnmanagedType.IUnknown)] object GetNetworkConnection(Guid connectionId);
        bool IsConnectedToInternet { [return: MarshalAs(UnmanagedType.VariantBool)] get; }
        bool IsConnected { [return: MarshalAs(UnmanagedType.VariantBool)] get; }
        int GetConnectivity();
    }
}
