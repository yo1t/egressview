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

    /// The reason alone, for the window as well as the notice. Empty when
    /// nothing is known.
    public static string Reason(string state, int? statusCode, PcNetwork network, bool ja) => state switch
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

    /// One line of the recent delivery changes shown in the window: when,
    /// what happened, and for a failure how many were waiting and when the
    /// Hub last took a batch.
    public static string HistoryLine(DeliveryEvent item, bool ja, TimeZoneInfo zone)
    {
        var culture = System.Globalization.CultureInfo.InvariantCulture;
        string Time(DateTimeOffset value) => TimeZoneInfo.ConvertTime(value, zone).ToString("M/d HH:mm", culture);
        var count = item.Pending.ToString("N0", culture);
        if (item.State == "start") return ja ? $"{Time(item.At)} サービス起動（未送信 {count} 件）" : $"{Time(item.At)} Service started ({count} pending)";
        if (!DeliveryNotificationTracker.IsFailure(item.State)) return ja ? $"{Time(item.At)} 送信できた" : $"{Time(item.At)} Delivering";
        var reason = Reason(item.State, item.StatusCode, WindowsNetwork.Parse(item.Network), ja).Trim();
        if (reason.Length == 0) reason = ja ? "送信できなかった。" : "Delivery failed.";
        var last = item.LastAcknowledgedAt is { } acknowledged
            ? ja ? $"、最後にHubが受け取ったのは {Time(acknowledged)}" : $", last taken by the Hub {Time(acknowledged)}"
            : "";
        return ja ? $"{Time(item.At)} {reason.TrimEnd('。')}（未送信 {count} 件{last}）"
            : $"{Time(item.At)} {reason.TrimEnd('.', ' ')} ({count} pending{last})";
    }
}
