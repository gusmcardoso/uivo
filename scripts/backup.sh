#!/usr/bin/env bash
# Backup do banco do Uptrue: cópia consistente (VACUUM INTO), testada, compactada, com rotação.
# Rode na pasta de deploy (a que tem compose.yml e .env), ex.: /opt/uptrue/backup.sh
#
#   BACKUP_DIR   destino (padrão /opt/backups/uptrue)
#   KEEP_DAYS    dias de retenção (padrão 14)
set -euo pipefail
cd "$(dirname "$0")" || exit 1

DEST="${BACKUP_DIR:-/opt/backups/uptrue}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP=$(date +%Y-%m-%d_%H%M%S)
FILE="uptrue-$STAMP.db"
mkdir -p "$DEST"
chmod 700 "$DEST"

container=$(docker compose ps -q uptrue)
[ -n "$container" ] || { echo "backup: o container do Uptrue não está rodando" >&2; exit 1; }
image=$(docker inspect -f '{{.Config.Image}}' "$container")

# VACUUM INTO gera uma cópia íntegra mesmo com o Uptrue gravando (copiar o arquivo direto pode corromper)
docker compose exec -T uptrue node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/uptrue.db').exec(\"VACUUM INTO '/data/backup-tmp.db'\");"
docker compose cp -q uptrue:/data/backup-tmp.db "$DEST/$FILE" 2>/dev/null || docker compose cp uptrue:/data/backup-tmp.db "$DEST/$FILE" >/dev/null
docker compose exec -T uptrue rm -f /data/backup-tmp.db

# Só vale como backup se abrir e tiver a estrutura esperada
sites=$(docker run --rm -v "$DEST:/b:ro" "$image" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/b/$FILE', { readOnly: true });
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') process.exit(3);
  console.log(db.prepare('SELECT COUNT(*) n FROM sites').get().n);") || {
  echo "backup: a cópia não passou na verificação de integridade" >&2
  rm -f "$DEST/$FILE"
  exit 1
}

gzip -9 "$DEST/$FILE"
find "$DEST" -name 'uptrue-*.db.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date '+%F %T') backup ok: $FILE.gz ($sites sites, $(du -h "$DEST/$FILE.gz" | cut -f1))"
