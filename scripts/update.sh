#!/usr/bin/env bash
# Atualiza o Uivo numa pasta de deploy (a que tem compose.yml e .env, ex.: /opt/uivo).
#
#   ./update.sh            atualiza para a versão mais nova publicada
#   ./update.sh 0.1.7      vai para uma versão específica (também serve para voltar)
#   ./update.sh --check    só mostra a versão atual e a mais nova
#
# Passos: backup → compose.yml da versão → nova imagem → espera ficar saudável →
# se não ficar, volta sozinho para a versão anterior → limpa imagens antigas.
set -euo pipefail
cd "$(dirname "$0")" || exit 1

REPO="${UIVO_REPO:-gusmcardoso/uivo}"
# onde ficam compose.yml e scripts de cada versão (sobrescrevível: testes usam uma pasta local)
RAW="${UIVO_RAW:-https://raw.githubusercontent.com/${REPO}}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
ROLLBACK_TIMEOUT="${ROLLBACK_TIMEOUT:-120}"
log() { echo "$(date '+%F %T') $*"; }
die() { log "ERRO: $*" >&2; exit 1; }

[ -f compose.yml ] && [ -f .env ] || die "rode na pasta de deploy (compose.yml e .env não encontrados em $PWD)"
[ ! -d .git ] || die "isto é um clone do repositório; aqui use: git pull && docker compose pull && docker compose up -d"

current=$(grep -E '^UIVO_TAG=' .env | tail -1 | cut -d= -f2- || true)
current=${current:-latest}
# mesma imagem que o compose usa (UIVO_IMAGE no .env permite fork ou registro próprio)
IMAGE=$(grep -E '^UIVO_IMAGE=' .env | tail -1 | cut -d= -f2- || true)
IMAGE="${IMAGE:-ghcr.io/${REPO}}"

latest_published() {
  curl -fsSL "https://api.github.com/repos/${REPO}/tags?per_page=100" |
    grep -oE '"name": *"v[0-9]+\.[0-9]+\.[0-9]+"' | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -1
}

target="${1:-}"
if [ "$target" = "--check" ]; then
  echo "atual: $current | mais nova publicada: $(latest_published || echo '?')"
  exit 0
fi
[ -n "$target" ] || target=$(latest_published) || die "não consegui consultar as versões publicadas"
[[ "$target" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "versão inválida: '$target' (use o formato 0.1.7)"

if [ "$target" = "$current" ] && [ "${FORCE:-}" != 1 ]; then
  log "já está na versão $current (FORCE=1 para reaplicar)"
  exit 0
fi
log "atualizando de $current para $target"

set_tag() {
  if grep -qE '^UIVO_TAG=' .env; then sed -i "s|^UIVO_TAG=.*|UIVO_TAG=$1|" .env; else printf '\nUIVO_TAG=%s\n' "$1" >>.env; fi
}

# Quantos sites o banco em uso tem (vazio se não der para ler)
site_count() {
  docker compose exec -T uivo node -e "
    const { DatabaseSync } = require('node:sqlite');
    console.log(new DatabaseSync('/data/uivo.db', { readOnly: true }).prepare('SELECT COUNT(*) n FROM sites').get().n);" 2>/dev/null |
    tr -dc '0-9' || true
}

wait_healthy() {
  local id status
  for _ in $(seq 1 "${1:-$HEALTH_TIMEOUT}"); do
    id=$(docker compose ps -q uivo)
    status=$([ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo none)
    [ "$status" = healthy ] && return 0
    sleep 1
  done
  return 1
}

# 1. Confere que a versão existe ANTES de mexer em qualquer coisa (versão inválida = nada muda)
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$RAW/v${target}/compose.yml" -o "$tmp" ||
  die "não encontrei o compose.yml da versão $target (a tag v$target existe?); nada foi alterado"
docker compose -f "$tmp" --env-file .env config -q || die "compose.yml da versão $target inválido; nada foi alterado"
# imagem baixada antes de parar o container atual: se falhar aqui, nada muda
docker pull -q "$IMAGE:$target" >/dev/null || die "imagem $IMAGE:$target não encontrada; nada foi alterado"

# 2. Backup (só se já houver um Uivo rodando) e quantos sites existem agora
sites_before=""
if [ -n "$(docker compose ps -q uivo 2>/dev/null)" ]; then
  sites_before=$(site_count)
  if [ -x ./backup.sh ]; then ./backup.sh || die "backup falhou; atualização cancelada (nada foi alterado)"; fi
fi

# 3. Troca: guarda o estado atual para o rollback e aplica a versão nova
cp compose.yml compose.yml.bak
cp .env .env.bak
cp "$tmp" compose.yml
set_tag "$target"
docker compose up -d --no-build --remove-orphans uivo >/dev/null 2>&1 || true

# 4. Saúde e dados; se falhar, volta para a versão anterior
problem=""
if ! wait_healthy; then
  problem="não ficou saudável em ${HEALTH_TIMEOUT}s"
else
  # Trava contra "saudável, mas vazio" (ex.: volume de dados trocado): antes havia sites e agora não há nenhum
  sites_after=$(site_count)
  if [ -n "$sites_before" ] && [ "$sites_before" -gt 0 ] && [ "${sites_after:-0}" = 0 ]; then
    problem="subiu sem os dados (antes $sites_before sites, agora 0)"
  fi
fi
if [ -z "$problem" ]; then
  log "versão $target no ar e saudável"
  rm -f compose.yml.bak .env.bak
else
  log "a versão $target $problem; voltando para $current"
  docker compose logs --no-color --tail 20 uivo >&2 || true
  mv compose.yml.bak compose.yml
  mv .env.bak .env
  docker compose up -d --no-build uivo >/dev/null 2>&1 || true
  if wait_healthy "$ROLLBACK_TIMEOUT"; then die "rollback concluído: segue na versão $current"; fi
  die "rollback feito, mas a versão $current também não ficou saudável: verifique já (docker compose logs uivo)"
fi

# 5. Limpa imagens antigas do Uivo (mantém a atual e a anterior, para um rollback rápido)
# "|| true": sem imagem antiga, o grep não acha nada e devolve 1; com pipefail isso encerraria o script
{
  docker images "$IMAGE" --format '{{.Tag}}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | grep -vxF -e "$target" -e "$current" |
    while read -r old; do docker rmi -f "$IMAGE:$old" >/dev/null 2>&1 || true; done
} || true
docker image prune -f >/dev/null 2>&1 || true

# 6. Atualiza os próprios scripts de operação para os da versão instalada
for s in update.sh backup.sh restore.sh offsite-backup.sh deploy-entry.sh; do
  if curl -fsSL "$RAW/v${target}/scripts/$s" -o "$tmp" 2>/dev/null && bash -n "$tmp"; then
    # grava ao lado e renomeia: troca atômica, sem mexer no arquivo que está em execução
    install -m 700 "$tmp" "./$s.new" && mv -f "./$s.new" "./$s"
  fi
done
log "pronto: $current → $target"
