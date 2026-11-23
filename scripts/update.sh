#!/usr/bin/env bash
# Atualiza o Uptrue numa pasta de deploy (a que tem compose.yml e .env, ex.: /opt/uptrue).
#
#   ./update.sh            atualiza para a versão mais nova publicada
#   ./update.sh 0.1.7      vai para uma versão específica (também serve para voltar)
#   ./update.sh --check    só mostra a versão atual e a mais nova
#
# Passos: backup → compose.yml da versão → nova imagem → espera ficar saudável →
# se não ficar, volta sozinho para a versão anterior → limpa imagens antigas.
set -euo pipefail
cd "$(dirname "$0")" || exit 1

REPO="${UPTRUE_REPO:-gusmcardoso/uptrue}"
IMAGE="ghcr.io/${REPO}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
ROLLBACK_TIMEOUT="${ROLLBACK_TIMEOUT:-120}"
log() { echo "$(date '+%F %T') $*"; }
die() { log "ERRO: $*" >&2; exit 1; }

[ -f compose.yml ] && [ -f .env ] || die "rode na pasta de deploy (compose.yml e .env não encontrados em $PWD)"
[ ! -d .git ] || die "isto é um clone do repositório; aqui use: git pull && docker compose pull && docker compose up -d"

current=$(grep -E '^UPTRUE_TAG=' .env | tail -1 | cut -d= -f2- || true)
current=${current:-latest}

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
  if grep -qE '^UPTRUE_TAG=' .env; then sed -i "s|^UPTRUE_TAG=.*|UPTRUE_TAG=$1|" .env; else printf '\nUPTRUE_TAG=%s\n' "$1" >>.env; fi
}

wait_healthy() {
  local id status
  for _ in $(seq 1 "${1:-$HEALTH_TIMEOUT}"); do
    id=$(docker compose ps -q uptrue)
    status=$([ -n "$id" ] && docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo none)
    [ "$status" = healthy ] && return 0
    sleep 1
  done
  return 1
}

# 1. Backup antes de qualquer mudança (só se já houver um Uptrue rodando)
if [ -x ./backup.sh ] && [ -n "$(docker compose ps -q uptrue 2>/dev/null)" ]; then
  ./backup.sh || die "backup falhou; atualização cancelada (nada foi alterado)"
fi

# 2. compose.yml da versão alvo, validado antes de substituir o atual
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "https://raw.githubusercontent.com/${REPO}/v${target}/compose.yml" -o "$tmp" ||
  die "não encontrei o compose.yml da versão $target (a tag v$target existe?)"
docker compose -f "$tmp" --env-file .env config -q || die "compose.yml da versão $target inválido"
cp compose.yml compose.yml.bak
cp .env .env.bak

# 3. Nova imagem (baixa antes de parar o container atual: se falhar aqui, nada muda)
docker pull -q "$IMAGE:$target" >/dev/null || {
  rm -f compose.yml.bak .env.bak
  die "imagem $IMAGE:$target não encontrada; nada foi alterado"
}
cp "$tmp" compose.yml
set_tag "$target"
docker compose up -d --no-build --remove-orphans uptrue >/dev/null 2>&1 || true

# 4. Saúde; se falhar, volta para a versão anterior
if wait_healthy; then
  log "versão $target no ar e saudável"
  rm -f compose.yml.bak .env.bak
else
  log "a versão $target não ficou saudável em ${HEALTH_TIMEOUT}s; voltando para $current"
  docker compose logs --no-color --tail 20 uptrue >&2 || true
  mv compose.yml.bak compose.yml
  mv .env.bak .env
  docker compose up -d --no-build uptrue >/dev/null 2>&1 || true
  if wait_healthy "$ROLLBACK_TIMEOUT"; then die "rollback concluído: segue na versão $current"; fi
  die "rollback feito, mas a versão $current também não ficou saudável: verifique já (docker compose logs uptrue)"
fi

# 5. Limpa imagens antigas do Uptrue (mantém a atual e a anterior, para um rollback rápido)
docker images "$IMAGE" --format '{{.Tag}}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | grep -vxF -e "$target" -e "$current" |
  while read -r old; do docker rmi -f "$IMAGE:$old" >/dev/null 2>&1 || true; done
docker image prune -f >/dev/null 2>&1 || true

# 6. Atualiza os próprios scripts de operação para os da versão instalada
for s in update.sh backup.sh deploy-entry.sh; do
  if curl -fsSL "https://raw.githubusercontent.com/${REPO}/v${target}/scripts/$s" -o "$tmp" 2>/dev/null && bash -n "$tmp"; then
    # grava ao lado e renomeia: troca atômica, sem mexer no arquivo que está em execução
    install -m 700 "$tmp" "./$s.new" && mv -f "./$s.new" "./$s"
  fi
done
log "pronto: $current → $target"
