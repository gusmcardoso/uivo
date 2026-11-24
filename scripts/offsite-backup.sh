#!/usr/bin/env bash
# Cópia criptografada dos backups para fora do servidor (rclone + crypt), com retenção.
#
#   ./offsite-backup.sh               envia o backup local mais recente
#   ./offsite-backup.sh --list        backups guardados no destino
#   ./offsite-backup.sh --fetch NOME  baixa (e descriptografa) um backup para a pasta local
#
# O rclone roda por container (nada instalado no servidor). A configuração fica em
# ./rclone/rclone.conf (chmod 600): um remote de armazenamento (ex.: Object Storage da Oracle)
# e, por cima dele, um remote "crypt" que criptografa conteúdo e nomes antes do envio.
#   OFFSITE_REMOTE     remote de destino (padrão offsite:)
#   OFFSITE_KEEP_DAYS  retenção no destino (padrão 30)
#   BACKUP_DIR         backups locais (padrão /opt/backups/uivo)
set -euo pipefail
cd "$(dirname "$0")" || exit 1

SRC="${BACKUP_DIR:-/opt/backups/uivo}"
CONF="${RCLONE_CONFIG_DIR:-$PWD/rclone}"
REMOTE="${OFFSITE_REMOTE:-offsite:}"
KEEP="${OFFSITE_KEEP_DAYS:-30}"
IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.69.1}"
log() { echo "$(date '+%F %T') $*"; }
die() { log "ERRO: $*" >&2; exit 1; }

[ -f "$CONF/rclone.conf" ] || die "configuração não encontrada em $CONF/rclone.conf (veja docs/DEPLOY.md)"
# Traduz os erros mais comuns do rclone/Object Storage para o que fazer
explain() {
  local err=$1
  case "$err" in
    *"Tenant not found"*) die "namespace errado no endpoint (é o código da conta, não o nome do bucket): rclone config update oci endpoint=..." ;;
    *"secret key required"* | *SignatureDoesNotMatch* | *InvalidAccessKeyId*) die "chave de acesso recusada: confira o Access key e o Secret (Customer secret keys) no rclone.conf" ;;
    *"directory not found"* | *NoSuchBucket*) die "bucket não encontrado: confira o nome do bucket em 'remote =' da seção [offsite] do rclone.conf" ;;
    *"no such host"* | *"dial tcp"*) die "sem conexão com o Object Storage: confira o endpoint e a internet do servidor" ;;
    *) die "falha no rclone: $(printf '%s' "$err" | tail -1)" ;;
  esac
}
rc_or_explain() { # roda o rclone; se falhar, explica o erro
  local out
  if ! out=$(rc "$@" 2>&1); then explain "$out"; fi
  printf '%s' "$out"
}

rc() {
  docker run --rm --user "$(id -u):$(id -g)" -e RCLONE_CONFIG=/config/rclone.conf \
    -v "$CONF:/config" -v "$SRC:/data" "$IMAGE" "$@"
}

case "${1:-}" in
  --list)
    rc_or_explain lsl "$REMOTE" | sort -k2,3
    exit 0
    ;;
  --fetch)
    name="${2:-}"
    [[ "$name" =~ ^(uivo|uptrue)-[0-9A-Za-z_-]+\.db\.gz$ ]] || die "informe o nome do backup (veja --list)"
    rc_or_explain copy "$REMOTE$name" /data/ >/dev/null
    gzip -t "$SRC/$name" || die "o arquivo baixado está corrompido"
    log "baixado: $SRC/$name  (restaure com: ./restore.sh $SRC/$name)"
    exit 0
    ;;
  "") ;;
  *) die "uso: ./offsite-backup.sh [--list | --fetch NOME]" ;;
esac

latest=$(ls -1t "$SRC"/uivo-*.db.gz 2>/dev/null | head -1) || true
[ -n "${latest:-}" ] || die "nenhum backup local em $SRC para enviar"
name=$(basename "$latest")

rc_or_explain copy "/data/$name" "$REMOTE" >/dev/null
# Só conta como enviado se aparecer no destino com o mesmo tamanho
local_size=$(stat -c %s "$latest")
remote_size=$(rc lsl "$REMOTE$name" 2>/dev/null | awk '{print $1}')
[ "$remote_size" = "$local_size" ] || die "envio não confirmado (local $local_size bytes, destino '${remote_size:-ausente}')"
rc delete --min-age "${KEEP}d" "$REMOTE" >/dev/null 2>&1 || true
log "enviado para fora do servidor: $name ($(du -h "$latest" | cut -f1), criptografado; retenção ${KEEP} dias)"
