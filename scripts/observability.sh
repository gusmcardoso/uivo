#!/usr/bin/env bash
# Perfil de observabilidade do Uivo (Prometheus, Grafana, Loki, Alloy, node_exporter, cAdvisor).
#
#   scripts/observability.sh check    confere .env, Docker e porta antes de subir
#   scripts/observability.sh init     gera no .env só os segredos que faltam (nunca sobrescreve)
#   scripts/observability.sh up       confere, sobe a pilha e espera o Grafana ficar pronto
#   scripts/observability.sh status   containers e saúde dos alvos do Prometheus
#   scripts/observability.sh logs     logs da pilha (Ctrl+C para sair)
#   scripts/observability.sh down     para só a observabilidade (o Uivo continua; os dados ficam)
#
# ENV_FILE=/caminho/.env muda o arquivo de variáveis (padrão: .env na raiz do projeto).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ENV_FILE="${ENV_FILE:-.env}"
SERVICES=(prometheus node-exporter cadvisor loki alloy grafana)
REQUIRED=(AUTH_SECRET METRICS_TOKEN GRAFANA_ADMIN_PASSWORD)

if [ -t 1 ]; then R=$'\e[31m' G=$'\e[32m' Y=$'\e[33m' B=$'\e[1m' N=$'\e[0m'; else R='' G='' Y='' B='' N=''; fi
ok() { echo "${G}✔${N} $1"; }
warn() { echo "${Y}!${N} $1"; }
bad() { echo "${R}✘${N} $1"; }

# Lê uma variável do .env sem executar o arquivo (um .env não deve ser "sourced": pode conter código)
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | sed -E 's/^["'\'']|["'\'']$//g'
}

compose() { docker compose --env-file "$ENV_FILE" "$@"; }

cmd_check() {
  local fails=0
  echo "${B}Conferindo o ambiente${N}"

  if [ -f "$ENV_FILE" ]; then
    ok "arquivo $ENV_FILE encontrado"
  else
    bad "arquivo $ENV_FILE não existe: copie o modelo com  cp .env.example $ENV_FILE"
    return 1
  fi

  for var in "${REQUIRED[@]}"; do
    local value
    value=$(env_get "$var")
    if [ -z "$value" ]; then
      bad "$var não definido"
      fails=$((fails + 1))
    elif [ ${#value} -lt 16 ]; then
      bad "$var curto demais (${#value} caracteres; use 16 ou mais)"
      fails=$((fails + 1))
    else
      ok "$var definido"
    fi
  done
  if [ "$fails" -gt 0 ]; then
    echo "   → para gerar os que faltam:  ${B}scripts/observability.sh init${N}"
  fi

  if ! command -v docker >/dev/null 2>&1; then
    bad "Docker não encontrado"
    fails=$((fails + 1))
  elif ! docker info >/dev/null 2>&1; then
    bad "Docker instalado, mas o serviço não responde (o Docker Desktop está aberto?)"
    fails=$((fails + 1))
  else
    ok "Docker respondendo"
    # secrets lidos do ambiente exigem Docker Compose 2.23 ou mais novo
    local v major minor
    v=$(docker compose version --short 2>/dev/null | sed 's/^v//')
    major=${v%%.*}
    minor=$(echo "$v" | cut -d. -f2)
    if [ -z "$v" ] || [ "${major:-0}" -lt 2 ] || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -lt 23 ]; }; then
      bad "Docker Compose ${v:-desconhecido}: é preciso 2.23 ou mais novo"
      fails=$((fails + 1))
    else
      ok "Docker Compose $v"
    fi
  fi

  local port running
  port=$(env_get GRAFANA_PORT)
  port=${port:-3001}
  running=$(compose ps -q grafana 2>/dev/null)
  if [ -z "$running" ] && command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[:.]$port\b"; then
    bad "porta $port (Grafana) já está em uso por outro programa: troque com GRAFANA_PORT no $ENV_FILE"
    fails=$((fails + 1))
  else
    ok "porta $port livre para o Grafana"
  fi

  echo
  if [ "$fails" -eq 0 ]; then
    ok "${B}tudo pronto${N}"
  else
    bad "${B}$fails problema(s)${N}"
  fi
  return "$fails"
}

cmd_init() {
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f .env.example ]; then
      cp .env.example "$ENV_FILE"
      ok "criado $ENV_FILE a partir do .env.example"
    else
      : >"$ENV_FILE"
    fi
  fi
  local added=0
  for var in "${REQUIRED[@]}"; do
    local value
    value=$(env_get "$var")
    if [ -n "$value" ] && [ ${#value} -ge 16 ]; then
      ok "$var já definido (mantido)"
      continue
    fi
    local generated
    if [ "$var" = GRAFANA_ADMIN_PASSWORD ]; then
      generated=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
    else
      generated=$(openssl rand -hex 32)
    fi
    if grep -qE "^$var=" "$ENV_FILE"; then
      # Substitui a linha vazia/curta sem tocar nas outras
      sed -i "s|^$var=.*|$var=$generated|" "$ENV_FILE"
    else
      printf '\n%s=%s\n' "$var" "$generated" >>"$ENV_FILE"
    fi
    ok "$var gerado"
    added=$((added + 1))
  done
  chmod 600 "$ENV_FILE"
  ok "$ENV_FILE com permissão 600 (só o seu usuário lê)"
  [ "$added" -gt 0 ] && echo "   → senha do Grafana:  grep GRAFANA_ADMIN_PASSWORD $ENV_FILE"
  return 0
}

cmd_up() {
  cmd_check || { echo; bad "corrija os itens acima antes de subir"; return 1; }
  echo
  echo "${B}Subindo a pilha${N}"
  local log
  log=$(mktemp)
  if ! compose --profile observability up -d >"$log" 2>&1; then
    bad "falha ao subir a pilha:"
    tail -15 "$log"
    rm -f "$log"
    return 1
  fi
  rm -f "$log"
  ok "containers criados"
  local port
  port=$(env_get GRAFANA_PORT)
  port=${port:-3001}
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      echo
      ok "Grafana pronto em ${B}http://localhost:$port${N}  (usuário: $(env_get GRAFANA_ADMIN_USER | grep . || echo admin))"
      echo "   → senha:  grep GRAFANA_ADMIN_PASSWORD $ENV_FILE"
      return 0
    fi
    sleep 2
  done
  bad "o Grafana não respondeu em 2 minutos; veja:  scripts/observability.sh logs"
  return 1
}

cmd_status() {
  compose --profile observability ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
  echo
  if [ -n "$(compose ps -q prometheus 2>/dev/null)" ]; then
    echo "${B}Alvos do Prometheus${N}"
    # Métrica "up" (1 = alvo respondendo): rótulos saem em ordem alfabética, "job" por último
    compose exec -T prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=up' 2>/dev/null |
      grep -oE '"job":"[^"]+"\},"value":\[[^,]+,"[01]"' |
      sed -E 's/"job":"([^"]+)".*"([01])"$/\1 \2/' |
      sort |
      while read -r job up; do
        if [ "$up" = 1 ]; then ok "$job"; else bad "$job (não responde)"; fi
      done
  else
    warn "Prometheus não está rodando:  scripts/observability.sh up"
  fi
}

cmd_down() {
  compose --profile observability stop "${SERVICES[@]}" && compose --profile observability rm -f "${SERVICES[@]}" >/dev/null
  ok "observabilidade parada (o Uivo continua rodando; os dados ficam nos volumes)"
}

case "${1:-}" in
  check) cmd_check ;;
  init) cmd_init ;;
  up) cmd_up ;;
  status) cmd_status ;;
  logs) compose --profile observability logs -f --tail 50 "${SERVICES[@]}" ;;
  down) cmd_down ;;
  *)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
