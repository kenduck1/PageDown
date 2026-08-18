#!/usr/bin/env bash
#
# Uploads the five macOS code-signing secrets this repo's release workflow
# looks for. Run once, after you have a Developer ID Application certificate
# installed in your keychain.
#
#     ./scripts/setup-mac-signing.sh path/to/DeveloperID.p12
#
# What it does NOT do: create the certificate. That needs Keychain Access and
# the Apple Developer portal, and the steps are in the README's Signing
# section. This script only handles the part that is easy to get wrong --
# base64-encoding the .p12 without a trailing newline, and setting all five
# secrets with the exact names the workflow reads.
#
# Nothing here echoes a secret. Values are piped straight into `gh secret set`,
# which sends them over TLS and stores them encrypted; they never appear in
# your shell history or in this script's output.
set -euo pipefail

P12="${1:-}"
if [ -z "$P12" ] || [ ! -f "$P12" ]; then
  echo "usage: $0 path/to/DeveloperID.p12" >&2
  echo >&2
  echo "Export one from Keychain Access: find your 'Developer ID Application'" >&2
  echo "certificate, right-click -> Export, choose .p12, and set a password." >&2
  exit 1
fi

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run 'gh auth login' first" >&2; exit 1; }

echo "Repository: $(gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo

# -----------------------------------------------------------------------------
# The .p12 and its password.
# -----------------------------------------------------------------------------
# `base64 -i` on macOS emits no trailing newline, which matters: electron-builder
# decodes CSC_LINK directly and a stray newline yields an invalid archive with a
# confusing error.
base64 -i "$P12" | gh secret set MAC_CERT_P12_BASE64
echo "set MAC_CERT_P12_BASE64"

read -r -s -p "Password you set when exporting the .p12: " CERT_PW; echo
printf '%s' "$CERT_PW" | gh secret set MAC_CERT_PASSWORD
unset CERT_PW
echo "set MAC_CERT_PASSWORD"

# -----------------------------------------------------------------------------
# Notarization credentials.
# -----------------------------------------------------------------------------
read -r -p "Apple ID email (the one enrolled in the Developer Program): " APPLE_ID_VALUE
printf '%s' "$APPLE_ID_VALUE" | gh secret set APPLE_ID
echo "set APPLE_ID"

echo
echo "An APP-SPECIFIC password, not your Apple ID password."
echo "Create one at appleid.apple.com -> Sign-In and Security -> App-Specific Passwords."
read -r -s -p "App-specific password: " ASP; echo
printf '%s' "$ASP" | gh secret set APPLE_APP_SPECIFIC_PASSWORD
unset ASP
echo "set APPLE_APP_SPECIFIC_PASSWORD"

# The Team ID is embedded in the certificate's common name as
# "Developer ID Application: Some Name (TEAMID)", so offer it rather than
# making you go and look it up.
GUESS="$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/.*Developer ID Application: .*(\([A-Z0-9]\{10\}\))".*/\1/p' | head -1 || true)"
if [ -n "$GUESS" ]; then
  read -r -p "Team ID [$GUESS]: " TEAM_ID_VALUE
  TEAM_ID_VALUE="${TEAM_ID_VALUE:-$GUESS}"
else
  read -r -p "Team ID (10 characters, developer.apple.com -> Membership): " TEAM_ID_VALUE
fi
printf '%s' "$TEAM_ID_VALUE" | gh secret set APPLE_TEAM_ID
echo "set APPLE_TEAM_ID"

echo
echo "Secrets now on the repository:"
gh secret list

cat <<'NEXT'

Next: cut a release and the workflow signs and notarizes automatically.

    # bump "version" in package.json, commit, then
    git tag v0.1.1 && git push origin v0.1.1

The release run's summary reports whether the built app is ACTUALLY signed --
read off the artifact with codesign, not inferred from these secrets existing.
Notarization adds several minutes; Apple has to answer.

If anything is wrong the macOS build fails rather than silently shipping
unsigned, which is the behaviour you want.
NEXT
