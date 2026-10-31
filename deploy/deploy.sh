#!/usr/bin/env bash
# Runs on your Mac. Creates the GCP VM (first time) and deploys the server.
# Needs: gcloud logged in + project set (gcloud init), billing on, and a local .env with DECART_API_KEYS.
# Usage: ./deploy/deploy.sh            (override: ZONE=asia-south1-a VM=fitmirror-vm)
set -euo pipefail
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
cd "$(dirname "$0")/.."

ZONE="${ZONE:-asia-south1-a}"
REGION="${ZONE%-*}"
VM="${VM:-fitmirror-vm}"
IP_NAME="${IP_NAME:-fitmirror-ip}"
TAG=fitmirror-web

[ -f .env ] || { echo "Local .env not found (needs DECART_API_KEYS=...)"; exit 1; }
grep -qE '^(DECART_API_KEYS|DECART_API_KEY)=.+' .env || { echo ".env has no DECART_API_KEYS"; exit 1; }

echo "Project: $(gcloud config get-value project 2>/dev/null)  Zone: $ZONE"
gcloud services enable compute.googleapis.com

gcloud compute addresses describe "$IP_NAME" --region "$REGION" >/dev/null 2>&1 ||
  gcloud compute addresses create "$IP_NAME" --region "$REGION"
IP="$(gcloud compute addresses describe "$IP_NAME" --region "$REGION" --format='value(address)')"

gcloud compute firewall-rules describe fitmirror-allow-web >/dev/null 2>&1 ||
  gcloud compute firewall-rules create fitmirror-allow-web --allow=tcp:80,tcp:443 --target-tags="$TAG"

gcloud compute instances describe "$VM" --zone "$ZONE" >/dev/null 2>&1 ||
  gcloud compute instances create "$VM" --zone "$ZONE" --machine-type=e2-small \
    --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=20GB \
    --tags="$TAG" --address="$IP"

DOMAIN="${DOMAIN:-${IP//./-}.sslip.io}"   # sslip.io gives a free real HTTPS cert without owning a domain

echo "Waiting for SSH..."
for i in $(seq 1 20); do
  gcloud compute ssh "$VM" --zone "$ZONE" --quiet --command=true >/dev/null 2>&1 && break
  sleep 6
done

echo "Uploading code..."
COPYFILE_DISABLE=1 tar -czf /tmp/fitmirror.tar.gz \
  --exclude=node_modules --exclude=.git --exclude=.env --exclude='server/userkey.json' \
  --exclude=.playwright-mcp --exclude='*.pdf' --exclude='*.pptx' .
gcloud compute scp --zone "$ZONE" --quiet /tmp/fitmirror.tar.gz "$VM:/tmp/fitmirror.tar.gz"
gcloud compute scp --zone "$ZONE" --quiet .env "$VM:/tmp/fitmirror.env"
gcloud compute scp --zone "$ZONE" --quiet deploy/setup-vm.sh "$VM:/tmp/setup-vm.sh"

echo "Installing and starting..."
gcloud compute ssh "$VM" --zone "$ZONE" --quiet --command \
  "set -e; sudo bash /tmp/setup-vm.sh '$DOMAIN'; sudo rm -f /tmp/fitmirror.env /tmp/fitmirror.tar.gz"
rm -f /tmp/fitmirror.tar.gz

echo "Checking https://$DOMAIN/api/health ..."
# The API only answers extension origins; use the locked EXTENSION_ID if set.
EXT_ID="$(grep -E '^EXTENSION_ID=' .env | tail -1 | cut -d= -f2 | tr -d '\r' || true)"
ORIGIN="chrome-extension://${EXT_ID:-deploycheck}"
ok=0
for i in $(seq 1 15); do
  if curl -fsS -H "Origin: $ORIGIN" "https://$DOMAIN/api/health"; then ok=1; echo; break; fi
  sleep 4
done
[ "$ok" = 1 ] || { echo "Health check failed. Logs: gcloud compute ssh $VM --zone $ZONE --command 'sudo journalctl -u fitmirror -n 50'"; exit 1; }

cat <<DONE

Server:  https://$DOMAIN
Health:  https://$DOMAIN/api/health
Next:    SERVER_URL=https://$DOMAIN npm run build   (then reload the extension)
Logs:    gcloud compute ssh $VM --zone $ZONE --command 'sudo journalctl -u fitmirror -f'
DONE
