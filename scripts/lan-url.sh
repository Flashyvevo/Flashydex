#!/usr/bin/env bash
set -euo pipefail

ips=()
if command -v ipconfig >/dev/null 2>&1; then
  while IFS= read -r ip; do
    [[ "$ip" == 127.* || -z "$ip" ]] || ips+=("$ip")
  done < <(ipconfig | sed -nE 's/.*IPv4[^:]*: *([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+).*/\1/p')
elif command -v hostname >/dev/null 2>&1 && hostname -I >/dev/null 2>&1; then
  for ip in $(hostname -I); do
    [[ "$ip" == 127.* || -z "$ip" ]] || ips+=("$ip")
  done
elif command -v ip >/dev/null 2>&1; then
  while IFS= read -r ip; do
    [[ "$ip" == 127.* || -z "$ip" ]] || ips+=("$ip")
  done < <(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1)
fi

if [[ ${#ips[@]} -eq 0 ]]; then
  echo "No non-loopback IPv4 address found." >&2
  exit 1
fi

printf '%s\n' "${ips[@]}" | sort -u | while IFS= read -r ip; do
  printf 'http://%s:3200\n' "$ip"
done
