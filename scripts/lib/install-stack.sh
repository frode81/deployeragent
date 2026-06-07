#!/usr/bin/env bash
# Felles install-steg (lokal på server eller via SSH).

# shellcheck source=bootstrap-core.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/bootstrap-core.sh"

detect_install_mode() {
  if [ -n "${INSTALL_MODE:-}" ]; then
    echo "$INSTALL_MODE"
    return
  fi
  if [ -z "${SERVER_HOST:-}" ]; then
    echo "local"
    return
  fi
  case "$SERVER_HOST" in
    localhost|127.0.0.1|::1) echo "local"; return ;;
  esac
  if hostname -I 2>/dev/null | tr ' ' '\n' | grep -qx "$SERVER_HOST"; then
    echo "local"
    return
  fi
  if hostname -f 2>/dev/null | grep -qx "$SERVER_HOST"; then
    echo "local"
    return
  fi
  if hostname -s 2>/dev/null | grep -qx "$SERVER_HOST"; then
    echo "local"
    return
  fi
  echo "remote"
}

sync_bundle_local() {
  local bundle_infra="$1"
  local bundle_agent="$2"
  local bundle_scripts="$3"
  local remote_root="$4"
  local deploy_user="$5"

  local infra_dir="${remote_root}/infrastructure"
  local agent_dir="${remote_root}/agent"
  local scripts_dir="${remote_root}/scripts"

  echo "== Kopierer infrastructure =="
  rsync -a --delete --exclude ".env" --exclude ".DS_Store" "${bundle_infra}/" "${infra_dir}/"

  echo "== Kopierer agent =="
  rsync -a --delete --exclude "node_modules" --exclude ".git" --exclude ".DS_Store" "${bundle_agent}/" "${agent_dir}/"

  echo "== Kopierer scripts =="
  mkdir -p "$scripts_dir"
  cp -f "${bundle_scripts}/cleanup-agent-server.sh" \
    "${bundle_scripts}/cleanup-agent-server-smart.sh" \
    "${bundle_scripts}/cleanup-agent-server-remote.sh" \
    "${bundle_scripts}/install-agent-cleanup-timer-local.sh" \
    "${bundle_scripts}/install-agent-cleanup-timer-remote.sh" \
    "${bundle_scripts}/configure-docker-registry-mirror.sh" \
    "${bundle_scripts}/sync-agent.sh" \
    "$scripts_dir/"
  chmod +x "$scripts_dir"/*.sh 2>/dev/null || true
  if [ -d "${bundle_scripts}/systemd" ]; then
    mkdir -p "${scripts_dir}/systemd"
    cp -f "${bundle_scripts}/systemd/"* "${scripts_dir}/systemd/"
  fi

  if [ "$(id -u)" -eq 0 ] && [ "$(whoami)" != "$deploy_user" ]; then
    chown -R "${deploy_user}:${deploy_user}" "${remote_root}"
  fi
}

sync_bundle_remote() {
  local bundle_infra="$1"
  local bundle_agent="$2"
  local bundle_scripts="$3"
  local server_user="$4"
  local server_host="$5"
  local remote_root="$6"

  local infra_dir="${remote_root}/infrastructure"
  local agent_dir="${remote_root}/agent"
  local scripts_dir="${remote_root}/scripts"

  echo "== Synker infrastructure =="
  rsync -az --delete \
    --omit-dir-times --no-times --no-perms --no-owner --no-group \
    --exclude ".env" --exclude ".DS_Store" \
    "${bundle_infra}/" "${server_user}@${server_host}:${infra_dir}/"

  echo "== Synker agent =="
  rsync -az --delete \
    --omit-dir-times --no-times --no-perms --no-owner --no-group \
    --exclude "node_modules" --exclude ".git" --exclude ".DS_Store" \
    "${bundle_agent}/" "${server_user}@${server_host}:${agent_dir}/"

  echo "== Synker scripts =="
  rsync -az \
    --omit-dir-times --no-times --no-perms --no-owner --no-group \
    "${bundle_scripts}/cleanup-agent-server.sh" \
    "${bundle_scripts}/cleanup-agent-server-smart.sh" \
    "${bundle_scripts}/cleanup-agent-server-remote.sh" \
    "${bundle_scripts}/install-agent-cleanup-timer-remote.sh" \
    "${bundle_scripts}/install-agent-cleanup-timer-local.sh" \
    "${bundle_scripts}/configure-docker-registry-mirror.sh" \
    "${bundle_scripts}/sync-agent.sh" \
    "${server_user}@${server_host}:${scripts_dir}/"
  if [ -d "${bundle_scripts}/systemd" ]; then
    rsync -az \
      --omit-dir-times --no-times --no-perms --no-owner --no-group \
      "${bundle_scripts}/systemd/" \
      "${server_user}@${server_host}:${scripts_dir}/systemd/"
  fi
}

configure_registry_mirror_local() {
  local scripts_dir="$1"
  chmod +x "${scripts_dir}/configure-docker-registry-mirror.sh"
  if [ "$(id -u)" -eq 0 ]; then
    bash "${scripts_dir}/configure-docker-registry-mirror.sh"
    systemd-run --collect --wait=false systemctl restart docker 2>/dev/null || systemctl restart docker
  else
    sudo bash "${scripts_dir}/configure-docker-registry-mirror.sh"
    sudo systemd-run --collect --wait=false systemctl restart docker 2>/dev/null || sudo systemctl restart docker
  fi
  wait_for_docker_local
}

configure_registry_mirror_remote() {
  local server_user="$1"
  local server_host="$2"
  local scripts_dir="$3"
  ssh -tt "${server_user}@${server_host}" "set -e
    chmod +x '${scripts_dir}/configure-docker-registry-mirror.sh'
    sudo bash '${scripts_dir}/configure-docker-registry-mirror.sh'
    sudo systemd-run --collect --wait=false systemctl restart docker 2>/dev/null || sudo systemctl restart docker
  "
  stty sane 2>/dev/null || true
  wait_for_docker_remote "$server_user" "$server_host"
}

wait_for_docker_local() {
  echo "Venter på Docker …"
  for _i in $(seq 1 90); do
    sleep 2
    if systemctl is-active docker >/dev/null 2>&1; then
      echo "Docker er aktiv."
      return 0
    fi
  done
  echo "ADVARSEL: Docker ble ikke aktiv innen tidsavbrudd." >&2
  return 1
}

wait_for_docker_remote() {
  local server_user="$1"
  local server_host="$2"
  echo "Venter på Docker …"
  for _i in $(seq 1 90); do
    sleep 2
    if ssh -o ConnectTimeout=8 "${server_user}@${server_host}" "systemctl is-active docker >/dev/null 2>&1"; then
      echo "Docker er aktiv."
      return 0
    fi
  done
  echo "ADVARSEL: Docker ble ikke aktiv innen tidsavbrudd." >&2
  return 1
}

write_env_local() {
  local env_file="$1"
  local tmp_env="$2"
  cp "$tmp_env" "$env_file"
}

write_env_remote() {
  local server_user="$1"
  local server_host="$2"
  local env_file="$3"
  local tmp_env="$4"
  rsync -az --omit-dir-times --no-times --no-perms --no-owner --no-group \
    "$tmp_env" "${server_user}@${server_host}:${env_file}"
}

start_stack_local() {
  local deploy_user="$1"
  local infra_dir="$2"
  run_as_deploy_docker "$deploy_user" "docker network create webserverpanel-net >/dev/null 2>&1 || true && cd $(printf '%q' "$infra_dir") && docker compose up -d --build"
}

start_stack_remote() {
  local server_user="$1"
  local server_host="$2"
  local infra_dir="$3"
  ssh "${server_user}@${server_host}" "docker network create webserverpanel-net >/dev/null 2>&1 || true && cd '${infra_dir}' && docker compose up -d --build"
}

configure_traefik_agent_route_local() {
  local deploy_user="$1"
  local agent_host="$2"
  run_as_deploy_docker "$deploy_user" "docker run --rm -v webserverpanel_traefik-dynamic:/dynamic alpine sh -c 'cat > /dynamic/agent.yml << \"EOF\"
http:
  routers:
    agent:
      rule: Host(\"${agent_host}\")
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
      service: agent
  services:
    agent:
      loadBalancer:
        servers:
          - url: http://agent:2080
EOF'"
}

configure_traefik_agent_route_remote() {
  local server_user="$1"
  local server_host="$2"
  local agent_host="$3"
  ssh "${server_user}@${server_host}" "docker run --rm -v webserverpanel_traefik-dynamic:/dynamic alpine sh -c 'cat > /dynamic/agent.yml << \"EOF\"
http:
  routers:
    agent:
      rule: Host(\`${agent_host}\`)
      entryPoints:
        - websecure
      tls:
        certResolver: letsencrypt
      service: agent
  services:
    agent:
      loadBalancer:
        servers:
          - url: http://agent:2080
EOF'"
}

verify_stack_local() {
  local deploy_user="$1"
  local infra_dir="$2"
  run_as_deploy_docker "$deploy_user" "cd $(printf '%q' "$infra_dir") && docker compose ps"
}

verify_stack_remote() {
  local server_user="$1"
  local server_host="$2"
  local infra_dir="$3"
  ssh "${server_user}@${server_host}" "cd '${infra_dir}' && docker compose ps"
}

install_cleanup_timer_local() {
  local remote_root="$1"
  local deploy_user="$2"
  local scripts_dir="$3"
  local systemd_dir="${scripts_dir}/systemd"

  sed "s|/home/deploy/skybygger|${remote_root}|g; s|^User=deploy|User=${deploy_user}|" \
    "${systemd_dir}/agent-cleanup.service" >/tmp/agent-cleanup.service

  if [ "$(id -u)" -eq 0 ]; then
    install -m 0644 /tmp/agent-cleanup.service /etc/systemd/system/agent-cleanup.service
    install -m 0644 "${systemd_dir}/agent-cleanup.timer" /etc/systemd/system/agent-cleanup.timer
    systemctl daemon-reload
    systemctl enable --now agent-cleanup.timer
    systemctl status --no-pager agent-cleanup.timer
  else
    sudo install -m 0644 /tmp/agent-cleanup.service /etc/systemd/system/agent-cleanup.service
    sudo install -m 0644 "${systemd_dir}/agent-cleanup.timer" /etc/systemd/system/agent-cleanup.timer
    sudo systemctl daemon-reload
    sudo systemctl enable --now agent-cleanup.timer
    sudo systemctl status --no-pager agent-cleanup.timer
  fi
}

detect_server_public_ip() {
  local install_mode="$1"
  local server_host="${2:-}"
  local ip=""

  if [ "$install_mode" = "local" ]; then
    for url in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
      ip="$(curl -4 -fsSL --max-time 6 "$url" 2>/dev/null | tr -d '[:space:]')"
      if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$ip"
        return 0
      fi
      ip=""
    done
    ip="$(hostname -I 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i !~ /^127\./) {print $i; exit}}')"
  else
    if [[ "$server_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      ip="$server_host"
    elif [ -n "$server_host" ]; then
      ip="$(getent ahostsv4 "$server_host" 2>/dev/null | awk '{print $1; exit}')"
    fi
  fi

  if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "$ip"
  fi
}

print_install_summary() {
  local install_mode="$1"
  local server_host="$2"
  local base_domain="$3"
  local agent_host="$4"
  local agent_secret="$5"

  local server_ip
  server_ip="$(detect_server_public_ip "$install_mode" "$server_host")"

  echo
  echo "══════════════════════════════════════════════════════════════"
  echo "  Ferdig — Webserver Panel node"
  echo "══════════════════════════════════════════════════════════════"
  echo
  if [ -n "$server_ip" ]; then
    echo "Server IP: ${server_ip}"
  else
    echo "Server IP: (fant ikke automatisk — sjekk hos leverandøren din)"
  fi
  echo
  echo "DNS — legg inn disse A-records hos domeneleverandøren:"
  echo "  (Pek begge mot server-IP${server_ip:+ ${server_ip}})"
  echo
  printf "  %-32s  A  →  %s\n" "*.${base_domain}" "${server_ip:-DIN_SERVER_IP}"
  printf "  %-32s  A  →  %s\n" "${agent_host}" "${server_ip:-DIN_SERVER_IP}"
  echo
  echo "Eksempler når DNS er propagert:"
  echo "  Bruker-apper:  https://min-app.${base_domain}"
  echo "  Agent health:  https://${agent_host}/health"
  echo
  echo "Dashboard — legg til server:"
  echo "  AGENT_URL=https://${agent_host}"
  echo "  AGENT_SECRET=${agent_secret}"
  echo
  echo "Tips: DNS kan ta noen minutter. Test med:"
  echo "  curl -I https://${agent_host}/health"
  echo "══════════════════════════════════════════════════════════════"
}
