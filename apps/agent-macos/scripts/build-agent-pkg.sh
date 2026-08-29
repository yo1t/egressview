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
#
# The name uses the short version, so rebuilding the same short version with a
# higher build collides here. That is a naming collision and nothing more:
# `installd` refuses a package whose **CFBundleVersion** matches what is already
# installed, and does not care about the short version. Measured 2026-08-22 --
# 0.5.29 build 91 installed cleanly over 0.5.29 build 90.
#
# So a trip to the machine needs a new build number and nothing else.
#
# **This used to stop and ask for the file to be deleted.** Both branches of
# that message ended in "delete it", while bumping the short version changed
# the file name and skipped the deletion entirely -- so the cheap path was the
# one that spent a user-facing version. It was taken four times on 2026-08-29
# alone (0.5.45 through 0.5.48), by someone who had just read this comment.
# A rule that argues with the incentive loses.
BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP_PATH/Contents/Info.plist")

# An unsigned build never takes the publishable name.
#
# Running this without an installer identity on 2026-08-29 moved the signed,
# notarised, already-published 0.5.48 aside and put an unsigned package in its
# place. The name that matches what is on the CDN has to keep meaning that.
if [[ -n "$INSTALLER_IDENTITY" ]]; then
  PKG_PATH="$DIST_DIR/egressview-agent-$VERSION.pkg"
else
  PKG_PATH="$DIST_DIR/egressview-agent-$VERSION-unsigned.pkg"
fi

# The previous file is moved aside, stamped with its own modification time.
# Nothing is lost and nobody is asked to do anything.
if [[ -e "$PKG_PATH" ]]; then
  ARCHIVED="${PKG_PATH%.pkg}.$(date -r "$PKG_PATH" +%Y%m%d-%H%M%S).pkg"
  mv "$PKG_PATH" "$ARCHIVED"
  printf 'Moved the previous %s aside to %s\n' "$(basename "$PKG_PATH")" "$(basename "$ARCHIVED")"
fi

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
#
# And the result is written down. On 2026-08-18 a Mac recorded nothing for
# thirteen and a half hours; the outage began at a `.pkg` install and ended at
# the next one, and this relaunch failing is the most likely reason. `|| true`
# left nothing to check afterwards, so the next occurrence would have produced
# the same empty hands.
#
# Recording only. A failed relaunch must not fail the install: the app is in
# /Applications and opening it by hand works, and turning a fixable state into
# an unfixable one helps nobody.
cat > "$SCRIPTS_DIR/postinstall" <<'POSTINSTALL'
#!/bin/bash
# Never fail the install because of what is below.
set +e

LOG=/var/log/egressview-agent-install.log
APP='/Applications/EgressView Agent.app'
EXECUTABLE="$APP/Contents/MacOS/EgressView Agent"
EXPECTED_BUILD=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist" 2>/dev/null)

note() { printf '%s postinstall %s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$LOG" 2>/dev/null; }

# Any agent process, wherever it was launched from -- then the path is compared.
# Matching only the expected path would hide the case that matters: a copy
# running from somewhere else reads as "nothing is running" when the truth is
# "the wrong version is running", and that distinction is what the 2026-08-18
# outage turned on.
probe() {
    local when=$1 pid path build found=0
    for pid in $(/usr/bin/pgrep -f 'EgressView Agent.app/Contents/MacOS/EgressView Agent' 2>/dev/null); do
        found=1
        path=$(/bin/ps -o comm= -p "$pid" 2>/dev/null)
        if [ "$path" = "$EXECUTABLE" ]; then
            build="$EXPECTED_BUILD"
            note "probe=${when}s pid=$pid build=$build path=expected"
        else
            # Its own bundle decides its build, not the one just installed.
            build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' \
                "${path%/Contents/MacOS/*}/Contents/Info.plist" 2>/dev/null)
            note "probe=${when}s pid=$pid build=${build:-unknown} expected=$EXPECTED_BUILD path=$path UNEXPECTED_PATH"
        fi
    done
    [ "$found" = 0 ] && note "probe=${when}s pid=none"
    return 0
}

note "begin expected_build=${EXPECTED_BUILD:-unknown}"

CONSOLE_USER=$(/usr/bin/stat -f '%Su' /dev/console 2>/dev/null)
CONSOLE_UID=$(/usr/bin/id -u "$CONSOLE_USER" 2>/dev/null)
note "console_user=${CONSOLE_USER:-none} console_uid=${CONSOLE_UID:-none}"

if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ] && [ -n "$CONSOLE_UID" ]; then
    /bin/launchctl asuser "$CONSOLE_UID" /usr/bin/open -a "$APP"
    note "open exit=$?"
else
    note "open skipped: no usable console user"
fi

# Twice, because one probe cannot tell "never launched" from "launched and died
# at once": absent at 2s and 10s means it never started, present then absent
# means it crashed immediately, and the middle case is the easy one to miss.
sleep 2;  probe 2
sleep 8;  probe 10

note "end"
exit 0
POSTINSTALL

chmod +x "$SCRIPTS_DIR/preinstall" "$SCRIPTS_DIR/postinstall"

COMPONENT_PKG="$WORK_DIR/component.pkg"

# Install into /Applications, and only there.
#
# `pkgbuild` marks an application bundle relocatable unless told otherwise. A
# relocatable package does not install where the package says; it asks
# LaunchServices and Spotlight where a bundle with this identifier already
# lives and installs over that. On 2026-08-28 this Mac had 22 registrations for
# `com.egressview.agent.macos` -- release round-trip directories the build
# script had already deleted, Debug builds, and an app indexed inside an Xcode
# archive whose recorded path (`/InstallationBuildProductsLocation/...`) does
# not exist. The installer chose one of those and refused: "the installer is
# prohibited from installing this software here", with no way for the person to
# find out why.
#
# That is not a developer-only situation. An old copy on a second disk, in a
# backup, or in a Downloads folder is enough to send a customer's installer
# somewhere other than /Applications, or to stop it entirely.
COMPONENT_PLIST="$WORK_DIR/component.plist"
pkgbuild --analyze --root "$PAYLOAD_DIR" "$COMPONENT_PLIST" >/dev/null
/usr/libexec/PlistBuddy -c 'Set :0:BundleIsRelocatable false' "$COMPONENT_PLIST"
if /usr/libexec/PlistBuddy -c 'Print :0:BundleIsRelocatable' "$COMPONENT_PLIST" | grep -q true; then
  fail 'The component plist still allows relocation; the package would install over an unrelated copy.'
fi

pkgbuild \
    --root "$PAYLOAD_DIR" \
    --install-location /Applications \
    --component-plist "$COMPONENT_PLIST" \
    --scripts "$SCRIPTS_DIR" \
    --identifier "$BUNDLE_ID" \
    --version "$VERSION" \
    "$COMPONENT_PKG"

# Checked on the built package, not only on the input: the guarantee is about
# what ships.
if xar -xf "$COMPONENT_PKG" PackageInfo -C "$WORK_DIR" 2>/dev/null; then
  if grep -q '<relocate>' "$WORK_DIR/PackageInfo"; then
    fail 'The built package still carries a relocate rule and would not reliably install into /Applications.'
  fi
  rm -f "$WORK_DIR/PackageInfo"
fi

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
# Said at the end, where the next decision gets made. A look at the machine
# needs a new CFBundleVersion; the short version is what people see and is
# spent when something is published (P3-32).
printf 'Version %s, build %s. For another look at the machine, raise CFBundleVersion only.\n' \
  "$VERSION" "$BUILD"
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
