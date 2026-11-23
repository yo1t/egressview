namespace EgressView.Agent.Core;

/// What the "delivery is not completing" notice says, given what the Agent
/// knows about why.
///
/// It says only what is known. "Windows says this PC has no internet" is
/// Windows' judgment, and a Hub on the local network can still be reachable
/// without the internet, so the notice reports it rather than calling it the
/// cause. A status code is the Hub answering, which rules the network out.
/// The notice can show on the lock screen, so it names no Hub and no
/// destination.
public static class DeliveryOutageText
{
    public static string Body(string state, int? statusCode, PcNetwork network, long pending, bool ja)
    {
        var count = pending.ToString("N0", System.Globalization.CultureInfo.InvariantCulture);
        var reason = Reason(state, statusCode, network, ja);
        return ja
            ? $"Hubへの送信が完了していません。{reason}未送信 {count} 件。Agentを開いて確認してください。"
            : $"Delivery to the Hub is not completing. {reason}{count} observations are pending. Open the Agent for details.";
    }

    private static string Reason(string state, int? statusCode, PcNetwork network, bool ja) => state switch
    {
        "authorization-required" => ja ? "Hubがこの端末の登録を受け付けていません。" : "The Hub no longer accepts this device's enrollment. ",
        "hub-incompatible" => ja ? "HubとAgentの版が合いません。" : "The Hub and the Agent have no version in common. ",
        "rate-limited" => ja ? "Hubが受け付けを制限しています。" : "The Hub is limiting what it accepts. ",
        "contract-rejected" or "invalid-acknowledgement" => statusCode is { } refused
            ? ja ? $"Hubが受け取りを拒否しています（HTTP {refused}）。" : $"The Hub is refusing the data (HTTP {refused}). "
            : ja ? "Hubが受け取りを拒否しています。" : "The Hub is refusing the data. ",
        "retryable" when statusCode is { } code =>
            ja ? $"Hubがエラーを返しています（HTTP {code}）。" : $"The Hub is answering with an error (HTTP {code}). ",
        "retryable" => network switch
        {
            PcNetwork.None => ja ? "このPCはネットワークにつながっていません。" : "This PC is not connected to a network. ",
            PcNetwork.LocalOnly => ja ? "Hubから応答がありません。WindowsはこのPCをインターネットにつながっていないと判定しています。"
                : "The Hub is not answering, and Windows reports that this PC has no internet access. ",
            _ => ja ? "Hubから応答がありません。" : "The Hub is not answering. ",
        },
        _ => "",
    };
}
