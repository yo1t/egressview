#!/usr/bin/env bash
# Packages the notarised agent as an installer that replaces it in place.
#
# The disk image asks the user to quit the agent and drag a new copy over the
# old one. That sequence broke four times in a row when it was first followed on
# a real machine, and the last break could not be fixed: macOS marks everything
# a sandboxed application writes and refuses to launch an app taken from it, so
# an agent that hands its user a disk image is handing over something that
# cannot be opened.
#
# An installer package is replaced by `installd`, not by the agent, so nothing
# the agent wrote is involved. It can also stop the running copy and start the
# new one itself, which is the part the user should never have been asked to do.
#
# Usage:
#   EGRESSVIEW_NOTARY_PROFILE=<keychain profile> \
#   EGRESSVIEW_INSTALLER_IDENTITY='Developer ID Installer: ...' \
#     ./scripts/build-agent-pkg.sh
#
# Without an installer identity it builds an unsigned package for local
# checking and says so. **Do not publish that one**: macOS refuses to install an
# unsigned package without the user overriding Gatekeeper by hand, which is
# exactly the kind of instruction this whole change exists to remove.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
AGENT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
DIST_DIR="$AGENT_DIR/dist"
SOURCE_ZIP="${EGRESSVIEW_AGENT_ZIP:-$DIST_DIR/EgressViewAgent.zip}"
NOTARY_PROFILE="${EGRESSVIEW_NOTARY_PROFILE:-}"
INSTALLER_IDENTITY="${EGRESSVIEW_INSTALLER_IDENTITY:-}"
APP_NAME="EgressView Agent.app"
BUNDLE_ID="com.egressview.agent.macos"

fail() { printf '%s\n' "$1" >&2; exit 1; }

[[ -f "$SOURCE_ZIP" ]] || fail "No signed build at $SOURCE_ZIP. Run ./scripts/build-release.sh first."

# Checked before the build, not after it. The notarisation profile has gone
# missing five times, and finding out at the end costs the whole build --
# twice on 2026-08-19. Its cause is not worth chasing; the wait is.
if [[ -n "$NOTARY_PROFILE" ]]; then
  if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    printf 'Notarisation profile "%s" is not usable. Register it and run this again:\n' "$NOTARY_PROFILE" >&2
    printf '  xcrun notarytool store-credentials %s --apple-id <apple-id> --team-id <team-id>\n' "$NOTARY_PROFILE" >&2
    exit 2
  fi
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/egressview-agent-pkg.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT

ditto -x -k "$SOURCE_ZIP" "$WORK_DIR/extracted"
APP_PATH="$WORK_DIR/extracted/$APP_NAME"
[[ -d "$APP_PATH" ]] || fail "$SOURCE_ZIP does not contain $APP_NAME"

VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_PATH/Contents/Info.plist")
[[ -n "$VERSION" ]] || fail 'Could not read the agent version from Info.plist'

# The file name carries the agent's own version, never the Hub's. They are
# separate release lines.
PKG_PATH="$DIST_DIR/egressview-agent-$VERSION.pkg"
[[ -e "$PKG_PATH" ]] && fail "$PKG_PATH already exists. Remove it or bump the version."

# The payload is the app alone, installed into /Applications.
PAYLOAD_DIR="$WORK_DIR/payload"
mkdir -p "$PAYLOAD_DIR"
ditto "$APP_PATH" "$PAYLOAD_DIR/$APP_NAME"

SCRIPTS_DIR="$WORK_DIR/scripts"
mkdir -p "$SCRIPTS_DIR"

# Quitting first is not optional: macOS will not replace a running application,
# and the error it gives ("the item is in use") says nothing about what to do.
# Asked politely, then firmly, then given up on -- a refusal to quit must not
# leave the installer hanging.
cat > "$SCRIPTS_DIR/preinstall" <<'PREINSTALL'
#!/bin/bash
# Collection stops here and resumes when the new copy starts. That gap is
# real and is stated in the installer's own text rather than left to be
# discovered afterwards.
/usr/bin/osascript -e 'tell application "EgressView Agent" to quit' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
    /usr/bin/pgrep -f '/Applications/EgressView Agent.app/Contents/MacOS/EgressView Agent' >/dev/null 2>&1 || exit 0
    sleep 1
done
/usr/bin/pkill -f '/Applications/EgressView Agent.app/Contents/MacOS/EgressView Agent' >/dev/null 2>&1 || true
sleep 2
exit 0
PREINSTALL

# Started as the user who is installing, not as root: an agent running as root
# would have a different container and no menu bar.
cat > "$SCRIPTS_DIR/postinstall" <<'POSTINSTALL'
#!/bin/bash
CONSOLE_USER=$(/usr/bin/stat -f '%Su' /dev/console)
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ]; then
    CONSOLE_UID=$(/usr/bin/id -u "$CONSOLE_USER")
    /bin/launchctl asuser "$CONSOLE_UID" /usr/bin/open -a '/Applications/EgressView Agent.app' || true
fi
exit 0
POSTINSTALL

chmod +x "$SCRIPTS_DIR/preinstall" "$SCRIPTS_DIR/postinstall"

COMPONENT_PKG="$WORK_DIR/component.pkg"
pkgbuild \
    --root "$PAYLOAD_DIR" \
    --install-location /Applications \
    --scripts "$SCRIPTS_DIR" \
    --identifier "$BUNDLE_ID" \
    --version "$VERSION" \
    "$COMPONENT_PKG"

# Says what installing did, including that monitoring stopped. An agent that
# stops watching without saying so is the fault this release spent the most
# effort removing, and an install is not an exception to it.
#
# Localised, because the app is. A Japanese user installing a Japanese
# application should not meet English at the one moment the installer explains
# that data is missing.
RESOURCES_DIR="$WORK_DIR/resources"
mkdir -p "$RESOURCES_DIR/en.lproj" "$RESOURCES_DIR/ja.lproj"
cat > "$RESOURCES_DIR/en.lproj/conclusion.txt" <<'CONCLUSION_EN'
EgressView Agent has been installed and started.

Monitoring stopped while the previous copy was replaced, and nothing was
recorded during that time. If macOS asks you to approve the network extension
again, monitoring stays off until you do.
CONCLUSION_EN
cat > "$RESOURCES_DIR/ja.lproj/conclusion.txt" <<'CONCLUSION_JA'
EgressView Agent をインストールし、起動しました。

置き換えの間は監視が止まっており、その間の通信は記録されていません。
macOS がネットワーク機能拡張の承認を求めた場合、承認するまで監視は止まったままです。
CONCLUSION_JA

DISTRIBUTION="$WORK_DIR/distribution.xml"
cat > "$DISTRIBUTION" <<DISTXML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
    <title>EgressView Agent</title>
    <organization>com.egressview</organization>
    <domains enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/>
    <options customize="never" require-scripts="true" hostArchitectures="arm64"/>
    <allowed-os-versions><os-version min="13.0"/></allowed-os-versions>
    <conclusion file="conclusion.txt"/>
    <pkg-ref id="$BUNDLE_ID"/>
    <choices-outline><line choice="default"/></choices-outline>
    <choice id="default"><pkg-ref id="$BUNDLE_ID"/></choice>
    <pkg-ref id="$BUNDLE_ID" version="$VERSION" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
DISTXML

mkdir -p "$DIST_DIR"
BUILT_PKG="$WORK_DIR/built.pkg"
productbuild \
    --distribution "$DISTRIBUTION" \
    --package-path "$WORK_DIR" \
    --resources "$RESOURCES_DIR" \
    "$BUILT_PKG"

if [[ -z "$INSTALLER_IDENTITY" ]]; then
    cp "$BUILT_PKG" "$PKG_PATH"
    printf 'No EGRESSVIEW_INSTALLER_IDENTITY: built an unsigned package for local checking only. Do not publish it.\n' >&2
    printf 'Installer package: %s\n' "$PKG_PATH"
    exit 0
fi

productsign --sign "$INSTALLER_IDENTITY" "$BUILT_PKG" "$WORK_DIR/signed.pkg"

if [[ -z "$NOTARY_PROFILE" ]]; then
    cp "$WORK_DIR/signed.pkg" "$PKG_PATH"
    printf 'No EGRESSVIEW_NOTARY_PROFILE: signed but not notarised. Do not publish it.\n' >&2
    printf 'Installer package: %s\n' "$PKG_PATH"
    exit 0
fi

# Notarised and stapled in its own right. Stapling matters here for the same
# reason it does for the disk image: a first install from an unstapled package
# asks Apple over the network, and the first thing a new user meets should not
# depend on their connection.
xcrun notarytool submit "$WORK_DIR/signed.pkg" --keychain-profile "$NOTARY_PROFILE" --wait
xcrun stapler staple "$WORK_DIR/signed.pkg"
cp "$WORK_DIR/signed.pkg" "$PKG_PATH"

# Checked as the user's Mac will check it, not as the machine that built it.
spctl --assess --type install --verbose=4 "$PKG_PATH"
shasum -a 256 "$PKG_PATH"
printf 'Installer package: %s\n' "$PKG_PATH"
