'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const uiRoot = path.join(__dirname, '..', '..', 'apps', 'agent-windows', 'src', 'EgressView.Agent.Ui');
const read = (name) => fs.readFileSync(path.join(uiRoot, name), 'utf8');
const windowXaml = read('MainWindow.xaml');
const windowCode = read('MainWindow.xaml.cs');
const detailView = read('AnomalyDetailView.cs');
const notifications = read('LocalNotificationService.cs');
const app = read('App.xaml.cs');
const strings = { ja: read(path.join('Resources', 'Strings.ja.xaml')), en: read(path.join('Resources', 'Strings.en.xaml')) };

function key(dictionary, name) {
  const match = dictionary.match(new RegExp(`x:Key="${name}">([^<]*)<`));
  return match && match[1];
}

// P3-180: the overview's cards said how many and nothing else, and the
// history kept only what fitted in a lock-screen notice.
describe('Windows Agent cards and notices explain themselves', () => {
  it('the Threats card opens the Threats tab and says so', () => {
    const card = windowXaml.slice(windowXaml.indexOf('x:Name="ThreatCard"'), windowXaml.indexOf('x:Name="ThreatCount"'));
    assert.ok(card.includes('Cursor="Hand"'));
    assert.ok(card.includes('ToolTip="{DynamicResource OpenThreatsTab}"'));
    assert.ok(card.includes('MouseLeftButtonUp="ThreatCard_MouseLeftButtonUp"'));
    // The Threats tab is the fourth.
    const tabs = [...windowXaml.matchAll(/<TabItem Header="\{DynamicResource (\w+)\}"/g)].map((match) => match[1]);
    assert.equal(tabs[3], 'Threats');
    assert.match(windowCode, /ThreatCard_MouseLeftButtonUp\([^)]*\) => SelectTab\(3\);/);
  });

  it('the outbound-anomaly card and each notice open a detail after half a second', () => {
    assert.match(windowCode, /AnomalyDetailView\.Attach\(OutboundAnomalyCard,/);
    assert.match(detailView, /OpenDelayMilliseconds = 500;/);
    assert.ok(windowXaml.includes('ToolTip="{Binding Detail}" ToolTipService.InitialShowDelay="500"'));
  });

  it('the history keeps an anomaly notice\'s breakdown, and older entries still read', () => {
    assert.match(notifications, /OutboundAnomalyRecord\? Anomaly = null,/);
    assert.match(windowCode, /anomaly: record\);/);
  });

  it('threat matches are notified, with the matches kept in the history and none in the notice', () => {
    assert.match(app, /Notifications\.Notify\("Threat", /);
    assert.match(app, /threats: notice\.Kept, moreThreats: notice\.More\)\)\s*threatNotices\.Accept\(notice, now\);/);
    assert.match(app, /hubDeliveryHealthy = ThreatNotificationPlanner\.HubDeliveryHealthy\(sample\);/);
    assert.match(notifications, /IReadOnlyList<ThreatFinding>\? Threats = null, int MoreThreats = 0\);/);
    // The notice's text is counts only; names never reach the lock screen.
    for (const language of ['ja', 'en']) {
      const body = key(strings[language], 'ThreatNoticeFormat');
      assert.ok(body.includes('{0:N0}'));
      assert.ok(!/\{[1-9]/.test(body));
    }
  });

    it('every new phrase exists in both languages, and a missing breakdown names the version that began keeping it', () => {
    for (const name of ['UsualFor15Minutes', 'AppsSentMost', 'DestinationsSentMost', 'OtherDestinationsFormat',
      'AnomalyBreakdownNotRecorded', 'AnomalyLargeTransfer', 'AnomalyDistributedTransfer', 'AnomaliesInPeriod',
      'NoAnomaliesInPeriod', 'AnomalyBaselineNotReady', 'ShowingNewestFormat', 'AnomalyNotMalware',
      'NoticeDetailsNotRecorded', 'OpenThreatsTab', 'NotificationKindOutboundAnomaly', 'ThreatNoticeTitle',
      'ThreatNoticeFormat', 'MoreThreatsFormat', 'FeedNotProof']) {
      assert.ok(key(strings.ja, name), `ja ${name}`);
      assert.ok(key(strings.en, name), `en ${name}`);
    }
    for (const language of ['ja', 'en']) {
      assert.ok(key(strings[language], 'AnomalyBreakdownNotRecorded').includes('0.1.140'));
      assert.ok(key(strings[language], 'NoticeDetailsNotRecorded').includes('0.1.140'));
    }
  });
});
