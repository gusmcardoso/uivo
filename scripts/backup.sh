#!/usr/bin/env bash
# Backup do banco do Uivo: cópia consistente (VACUUM INTO), testada, compactada, com rotação.
# Rode na pasta de deploy (a que tem compose.yml e .env), ex.: /opt/uivo/backup.sh
#
#   BACKUP_DIR   destino (padrão /opt/backups/uivo)
#   KEEP_DAYS    dias de retenção (padrão 14)
set -euo pipefail
cd "$(dirname "$0")" || exit 1

DEST="${BACKUP_DIR:-/opt/backups/uivo}"
KEEP_DAYS="${KEEP_DAYS:-14}"
# nanossegundos no nome: dois backups no mesmo segundo nunca colidem (e nada é sobrescrito)
STAMP=$(date +%Y-%m-%d_%H%M%S_%N)
FILE="uivo-$STAMP.db"
mkdir -p "$DEST"
chmod 700 "$DEST"

container=$(docker compose ps -q uivo)
[ -n "$container" ] || { echo "backup: o container do Uivo não está rodando" >&2; exit 1; }
image=$(docker inspect -f '{{.Config.Image}}' "$container")

# VACUUM INTO gera uma cópia íntegra mesmo com o Uivo gravando (copiar o arquivo direto pode corromper)
docker compose exec -T uivo node -e "
  const { DatabaseSync } = require('node:sqlite');
  new DatabaseSync('/data/uivo.db').exec(\"VACUUM INTO '/data/backup-tmp.db'\");"
# sem mensagens de progresso no log (uma falha na cópia é pega pela verificação de integridade abaixo)
docker compose cp uivo:/data/backup-tmp.db "$DEST/$FILE" >/dev/null 2>&1 ||
  { echo "backup: falha ao copiar o banco do container" >&2; exit 1; }
docker compose exec -T uivo rm -f /data/backup-tmp.db

# Só vale como backup se abrir e tiver a estrutura esperada
# roda como o usuário atual: a pasta é 700 e o uid do container (node) pode ser outro
sites=$(docker run --rm --user "$(id -u):$(id -g)" -v "$DEST:/b:ro" "$image" node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('/b/$FILE', { readOnly: true });
  if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') process.exit(3);
  console.log(db.prepare('SELECT COUNT(*) n FROM sites').get().n);") || {
  echo "backup: a cópia não passou na verificação de integridade" >&2
  rm -f "$DEST/$FILE"
  exit 1
}

gzip -9 "$DEST/$FILE"
# inclui os backups de antes da troca de nome, para a retenção também valer para eles.
# SKIP_ROTATION=1 (usado pelo restore.sh): sem limpeza, para não apagar o backup que está sendo restaurado
[ "${SKIP_ROTATION:-}" = 1 ] || find "$DEST" \( -name 'uivo-*.db.gz' -o -name 'uptrue-*.db.gz' \) -mtime +"$KEEP_DAYS" -delete
echo "$(date '+%F %T') backup ok: $FILE.gz ($sites sites, $(du -h "$DEST/$FILE.gz" | cut -f1))"
