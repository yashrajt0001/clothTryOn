# FitMirror – command cheatsheet

Run from project root (`/Users/ravindrasirvi/Desktop/clothTryOn`) on your Mac.
Never paste keys in chat/git. Keys live only in `.env`.

```bash
export PATH="$HOME/google-cloud-sdk/bin:$PATH"
Z=asia-south1-a
VM=fitmirror-vm
```

## 1. Update keys only (fast, no code upload)

Edit `.env` (`DECART_API_KEYS=key1,key2`), then:

```bash
gcloud compute scp --zone $Z .env $VM:/tmp/fitmirror.env
gcloud compute ssh $VM --zone $Z --command \
  "sudo install -m 600 -o fitmirror -g fitmirror /tmp/fitmirror.env /opt/fitmirror/.env && sudo rm -f /tmp/fitmirror.env && sudo systemctl restart fitmirror"
```

Reset "exhausted keys" list (after top-up / new key):

```bash
gcloud compute ssh $VM --zone $Z --command \
  "sudo rm -f /opt/fitmirror/server/userkey.json && sudo systemctl restart fitmirror"
```

## 2. Deploy server (code + .env, full)

```bash
./deploy/deploy.sh
```

Does: upload code tar + `.env` -> `setup-vm.sh` (install, systemd, Caddy HTTPS) -> restart -> health check.

## 3. Logs / status

```bash
# live logs
gcloud compute ssh $VM --zone $Z --command 'sudo journalctl -u fitmirror -f'

# last 100 lines
gcloud compute ssh $VM --zone $Z --command 'sudo journalctl -u fitmirror -n 100 --no-pager'

# service status
gcloud compute ssh $VM --zone $Z --command 'sudo systemctl status fitmirror --no-pager'

# restart only
gcloud compute ssh $VM --zone $Z --command 'sudo systemctl restart fitmirror'

# health (needs extension Origin)
curl -s -H "Origin: chrome-extension://kondafnmkdbnpnnjildilccogiejicim" https://34-93-139-160.sslip.io/api/health
```

## 4. Extension (rebuild + share zip)

```bash
SERVER_URL=https://34-93-139-160.sslip.io npm run build
(cd extension && zip -qr ~/Desktop/FitMirror.zip . -x "*.DS_Store")
```

Then chrome://extensions -> reload, refresh shop tab.
Plain `npm run build` (no SERVER_URL) = localhost:3001 build, local dev only.

## 5. VM cost control

```bash
gcloud compute instances stop  $VM --zone $Z   # pause (~stops compute billing)
gcloud compute instances start $VM --zone $Z   # resume
gcloud compute instances delete $VM --zone $Z  # remove after demo (static IP bills separately: delete fitmirror-ip too)
```
