using System.Net;
using System.Runtime.InteropServices;

namespace EgressView.Agent.Core;

public static class StartupSnapshot
{
    private const int AfInet = 2, AfInet6 = 23;
    private const int TcpOwnerPidAll = 5, UdpOwnerPid = 1;
    private const uint InsufficientBuffer = 122;

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(nint table, ref int size, bool order, int family, int tableClass, int reserved);
    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedUdpTable(nint table, ref int size, bool order, int family, int tableClass, int reserved);

    public static IReadOnlyList<StartupFlow> Capture()
    {
        var rows = new List<StartupFlow>();
        rows.AddRange(ReadTcp(AfInet));
        rows.AddRange(ReadTcp(AfInet6));
        rows.AddRange(ReadUdp(AfInet));
        rows.AddRange(ReadUdp(AfInet6));
        return rows;
    }

    private static byte[] ReadTable(bool tcp, int family, int tableClass, out int count)
    {
        var size = 0;
        var result = tcp ? GetExtendedTcpTable(0, ref size, false, family, tableClass, 0) : GetExtendedUdpTable(0, ref size, false, family, tableClass, 0);
        if (result is not (InsufficientBuffer or 0)) throw new InvalidOperationException($"IP Helper size probe failed: {result}");
        var pointer = Marshal.AllocHGlobal(size);
        try
        {
            result = tcp ? GetExtendedTcpTable(pointer, ref size, false, family, tableClass, 0) : GetExtendedUdpTable(pointer, ref size, false, family, tableClass, 0);
            if (result != 0) throw new InvalidOperationException($"IP Helper table read failed: {result}");
            var buffer = new byte[size];
            Marshal.Copy(pointer, buffer, 0, size);
            count = BitConverter.ToInt32(buffer, 0);
            return buffer;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    private static IEnumerable<StartupFlow> ReadTcp(int family)
    {
        var buffer = ReadTable(true, family, TcpOwnerPidAll, out var count);
        var rowSize = family == AfInet ? 24 : 56;
        for (var index = 0; index < count; index++)
        {
            var offset = 4 + index * rowSize;
            if (offset + rowSize > buffer.Length) yield break;
            var state = BitConverter.ToUInt32(buffer, offset + (family == AfInet ? 0 : 48));
            // A listening socket is not an egress connection. Startup coverage
            // exists to fill the gap for connections already carrying traffic.
            if (state != 5) continue; // MIB_TCP_STATE_ESTAB
            yield return family == AfInet
                ? new StartupFlow("TCP", V4(buffer, offset + 4), Port(buffer, offset + 8), V4(buffer, offset + 12), Port(buffer, offset + 16), BitConverter.ToInt32(buffer, offset + 20))
                : new StartupFlow("TCP", V6(buffer, offset), Port(buffer, offset + 20), V6(buffer, offset + 24), Port(buffer, offset + 44), BitConverter.ToInt32(buffer, offset + 52));
        }
    }

    private static IEnumerable<StartupFlow> ReadUdp(int family)
    {
        var buffer = ReadTable(false, family, UdpOwnerPid, out var count);
        var rowSize = family == AfInet ? 12 : 28;
        for (var index = 0; index < count; index++)
        {
            var offset = 4 + index * rowSize;
            if (offset + rowSize > buffer.Length) yield break;
            yield return family == AfInet
                ? new StartupFlow("UDP", V4(buffer, offset), Port(buffer, offset + 4), "", 0, BitConverter.ToInt32(buffer, offset + 8))
                : new StartupFlow("UDP", V6(buffer, offset), Port(buffer, offset + 20), "", 0, BitConverter.ToInt32(buffer, offset + 24));
        }
    }

    public static string FlowKey(string protocol, string localAddress, int localPort, string remoteAddress, int remotePort, int processId) =>
        protocol == "UDP" ? $"UDP|{localAddress}|{localPort}|{processId}" : $"TCP|{localAddress}|{localPort}|{remoteAddress}|{remotePort}|{processId}";
    private static int Port(byte[] buffer, int offset) { var raw = BitConverter.ToUInt32(buffer, offset); return (int)(((raw & 0xff) << 8) | ((raw >> 8) & 0xff)); }
    private static string V4(byte[] buffer, int offset) => new IPAddress(BitConverter.GetBytes(BitConverter.ToUInt32(buffer, offset))).ToString();
    private static string V6(byte[] buffer, int offset) { var bytes = new byte[16]; Array.Copy(buffer, offset, bytes, 0, 16); return new IPAddress(bytes).ToString(); }
}
