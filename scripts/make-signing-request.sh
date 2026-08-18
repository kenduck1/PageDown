#!/usr/bin/env bash
#
# STEP 1 of 2. Generates the private key and Certificate Signing Request you
# upload to Apple.
#
#     ./scripts/make-signing-request.sh "you@example.com" "Your Name"
#
# This replaces the Keychain Access → Certificate Assistant dance with
# something scriptable and inspectable. Apple accepts a standard CSR; there is
# nothing Apple-specific about generating one.
#
# Output goes to a directory OUTSIDE the repository, because one of the two
# files is a private key and must never be committed. It is written 0600 and
# the directory 0700.
#
# After this, run step 2: ./scripts/build-signing-p12.sh
set -euo pipefail

EMAIL="${1:-}"
NAME="${2:-}"
if [ -z "$EMAIL" ] || [ -z "$NAME" ]; then
  echo "usage: $0 <apple-id-email> <your name or company name>" >&2
  echo >&2
  echo 'e.g.  ./scripts/make-signing-request.sh "you@example.com" "Kai Ko"' >&2
  echo >&2
  echo "The NAME is what gets embedded in every signed build and is readable" >&2
  echo "by anyone via 'codesign -dv'. For an individual enrollment Apple" >&2
  echo "requires your legal name; an organization enrollment uses the company." >&2
  exit 1
fi

OUT="$HOME/.pagedown-signing"
mkdir -p "$OUT"
chmod 700 "$OUT"

KEY="$OUT/pagedown-signing.key"
CSR="$OUT/pagedown-signing.certSigningRequest"

if [ -f "$KEY" ]; then
  echo "A key already exists at $KEY" >&2
  echo "Refusing to overwrite it -- if you replace the key, any certificate" >&2
  echo "already issued against it becomes unusable." >&2
  exit 1
fi

# 2048-bit RSA is what Apple issues Developer ID certificates against.
# -nodes leaves the key unencrypted on disk; it is protected by 0600 and by
# living outside the repo. It gets a password when it becomes a .p12 in step 2,
# which is the form that actually travels.
openssl req -new \
  -newkey rsa:2048 \
  -nodes \
  -keyout "$KEY" \
  -out "$CSR" \
  -subj "/emailAddress=${EMAIL}/CN=${NAME}/C=US" \
  2>/dev/null

chmod 600 "$KEY"
chmod 644 "$CSR"

cat <<NEXT

Created:
  private key  $KEY   (0600, never leaves this machine, never commit it)
  request      $CSR

NEXT STEPS -- these are on Apple's site and cannot be scripted:

  1. Go to https://developer.apple.com/account/resources/certificates/add
  2. Choose **Developer ID Application**
       NOT "Mac App Distribution" -- only Developer ID works for software
       shipped outside the Mac App Store, and picking wrong costs a round trip.
  3. Upload:  $CSR
  4. Download the resulting .cer (usually to ~/Downloads)

Then run step 2, which builds the .p12 with Apple's intermediate certificate
included -- a chain the Keychain route gets for free and this one has to add
explicitly, or notarization rejects the signature:

  ./scripts/build-signing-p12.sh ~/Downloads/developerID_application.cer

NEXT
