namespace EgressView.Agent.Core;

/// What the screen may claim about where enrichment data comes from.
///
/// The claim used to be one sentence chosen by whether any direct source was
/// on: "Hub only, nothing is contacted directly" when none were, and otherwise
/// "some of this is fetched here, all of it download-only, and destinations
/// observed on this PC are never sent."
///
/// The second half of that stopped being true. The third-party lookup sends
/// the addresses this PC watched to ipwho.is -- that is what it is for -- so
/// the same settings card carried both "this sends watched addresses outside"
/// in a warning under the radio buttons and "observed destinations are never
/// sent" in the summary above them. One card, two opposite claims, and the
/// wrong one was the summary.
///
/// Deciding it here rather than in the window makes it a thing that can be
/// asserted. A privacy claim that only exists inside a UI callback is a claim
/// nothing checks.
public static class EnrichmentDisclosure
{
    /// The resource key for the sentence, and the sources to name in it.
    public readonly record struct Claim(string Key, IReadOnlyList<string> Sources);

    /// Nothing is fetched directly by this PC.
    public const string HubOnlyKey = "EnrichmentPrivacy";

    /// Some of it is, and all of it only downloads.
    public const string DownloadOnlyKey = "EnrichmentPrivacyDirect";

    /// Some of it is, and one of them is told what this PC watched.
    public const string SendsAddressesKey = "EnrichmentPrivacySendsAddresses";

    /// <param name="thirdPartyLookup">
    /// The only source that is sent anything. Everything else is a download.
    /// </param>
    public static Claim Describe(bool thirdPartyLookup, bool publicFeeds, bool countryTable,
        string thirdPartyName, string publicFeedsName, string countryTableName)
    {
        var sources = new List<string>();
        if (thirdPartyLookup) sources.Add(thirdPartyName);
        if (publicFeeds) sources.Add(publicFeedsName);
        if (countryTable) sources.Add(countryTableName);
        if (sources.Count == 0) return new(HubOnlyKey, sources);
        // The stronger claim is the one that has to be earned. A source that
        // is sent an address makes "download-only" false for the whole
        // sentence, however many of the others only download.
        return new(thirdPartyLookup ? SendsAddressesKey : DownloadOnlyKey, sources);
    }
}
