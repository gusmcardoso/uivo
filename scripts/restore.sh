#!/usr/bin/env bash
# Restaura um backup do banco do Uivo (rode na pasta de deploy, ex.: /opt/uivo).
#
#   ./restore.sh --list              backups disponíveis
#   ./restore.sh --latest            restaura o mais recente
#   ./restore.sh ARQUIVO.db.gz       restaura um específico (nome ou caminho)
#   --yes                            não pede confirmação
#
# Antes de mexer: confere o gzip e a integridade do banco, e faz backup do estado atual
# (a restauração pode ser desfeita). Depois: confere saúde e número de sites.
#   BACKUP_DIR   pasta dos backups (padrão /opt/backups/uivo)
set -euo pipefail
cd "$(dirname "$0")" || exit 1

DEST="${BACKUP_DIR:-/opt/backups/uivo}"
log() { echo "$(date '+%F %T') $*"; }
die() { log "ERRO: $*" >&2; exit 1; }

yes=0 arg=""
for a in "$@"; do
  case "$a" in
    --yes) yes=1 ;;
    *) arg="$a" ;;
  esac
done

if [ "$arg" = --list ] || [ -z "$arg" ]; then
  echo "Backups em $DEST (mais novo primeiro):"
  # inclui os backups de antes da troca de nome (uptrue-*.db.gz)
  ls -1t "$DEST"/uivo-*.db.gz "$DEST"/uptrue-*.db.gz 2>/dev/null | while read -r f; do
    printf '  %s  %s\n' "$(du -h "$f" | cut -f1)" "$(basename "$f")"
  done
  [ -n "$arg" ] || echo "Uso: ./restore.sh --latest | ARQUIVO.db.gz [--yes]"
  exit 0
fi

if [ "$arg" = --latest ]; then
  file=$(ls -1t "$DEST"/uivo-*.db.gz "$DEST"/uptrue-*.db.gz 2>/dev/null | head -1) || true
  [ -n "${file:-}" ] || die "nenhum backup em $DEST"
elif [ -f "$arg" ]; then
  file=$(realpath "$arg")
elif [ -f "$DEST/$arg" ]; then
  file="$DEST/$arg"
else
  die "backup não encontrado: $arg"
fi
name=$(basename "$file")
dir=$(dirname "$file")
[[ "$name" =~ ^(uivo|uptrue)-[0-9A-Za-z_-]+\.db\.gz$ ]] || die "nome de backup inesperado: $name"

container=$(docker compose ps -aq uivo)
[ -n "$container" ] || die "container do Uivo não encontrado (rode na pasta de deploy, com o Uivo criado)"
image=$(docker inspect -f '{{.Config.Image}}' "$container")
volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container")
[ -n "$volume" ] || die "volume de dados do Uivo não encontrado"

# 1. O backup é válido? (gzip íntegro + banco abre, passa no integrity_check e tem a tabela de sites)
gzip -t "$file" 2>/dev/null || die "$name está corrompido (gzip inválido); nada foi alterado"
sites=$(docker run --rm --user root -v "$dir:/b:ro" "$image" sh -c "
  gunzip -c '/b/$name' > /tmp/r.db && node -e \"
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync('/tmp/r.db', { readOnly: true });
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') process.exit(3);
    console.log(db.prepare('SELECT COUNT(*) n FROM sites').get().n);\"") ||
  die "$name não passou na verificação de integridade; nada foi alterado"
log "backup válido: $name ($sites sites)"

if [ "$yes" != 1 ]; then
  read -r -p "Restaurar $name? Os dados atuais serão substituídos (um backup deles é feito antes). [s/N] " ans
  [[ "$ans" =~ ^[sS]$ ]] || die "cancelado"
fi

# 2. Backup do estado atual (a restauração pode ser desfeita)
if [ -n "$(docker compose ps -q uivo)" ] && [ -x ./backup.sh ]; then
  # sem a limpeza de backups antigos: ela apagaria o próprio backup que vai ser restaurado (se tiver mais de KEEP_DAYS)
  SKIP_ROTATION=1 ./backup.sh || die "não consegui salvar o estado atual; restauração cancelada"
fi

# 3. Para, troca o banco (removendo WAL/SHM antigos, que misturariam dados) e devolve ao usuário do app
docker compose stop uivo >/dev/null 2>&1
docker run --rm --user root -v "$volume:/data" -v "$dir:/b:ro" "$image" sh -c "
  rm -f /data/uivo.db-wal /data/uivo.db-shm &&
  gunzip -c '/b/$name' > /data/uivo.db.restore &&
  mv /data/uivo.db.restore /data/uivo.db &&
  chown node:node /data/uivo.db && chmod 644 /data/uivo.db" || {
  docker compose start uivo >/dev/null 2>&1 || true
  die "falha ao copiar o backup para o volume"
}
docker compose start uivo >/dev/null 2>&1

# 4. Confere saúde e conteúdo
for _ in $(seq 1 90); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo none)
  [ "$status" = healthy ] && break
  sleep 1
done
[ "$status" = healthy ] || die "o Uivo não ficou saudável depois da restauração (veja: docker compose logs uivo)"
now=$(docker compose exec -T uivo node -e "
  const { DatabaseSync } = require('node:sqlite');
  console.log(new DatabaseSync('/data/uivo.db', { readOnly: true }).prepare('SELECT COUNT(*) n FROM sites').get().n);")
[ "$now" = "$sites" ] || die "restaurado, mas o número de sites não confere (backup: $sites, agora: $now)"
log "restaurado: $name ($sites sites) — Uivo saudável"
