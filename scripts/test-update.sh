#!/usr/bin/env bash
# Testa o update.sh como num servidor: pasta de deploy isolada começando numa versão,
# depois atualização normal, versão inexistente (nada muda), versão que não fica saudável
# a tempo e versão que sobe sem os dados (rollback automático nos dois casos).
#
# Autossuficiente: gera a imagem da árvore de trabalho, publica "versões" de teste num
# registro local (localhost) e serve compose.yml/scripts de uma pasta, no lugar do GitHub.
#
#   scripts/test-update.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REPO_DIR=$PWD

DIR=$(mktemp -d)
REG_PORT="${REG_PORT:-5055}"
PORT="${PORT:-3730}"
REG="localhost:$REG_PORT/uivo"
export COMPOSE_PROJECT_NAME=uivo-update-test BACKUP_DIR="$DIR/backups" UIVO_RAW="file://$DIR/raw"
FROM=0.0.1
TO=0.0.2
FAILS=0

ok() {
  if [ "$2" = true ]; then
    echo "OK    $1"
  else
    echo "FALHA $1 → ${2:-}"
    FAILS=$((FAILS + 1))
    # anotação com o motivo (sem quebras de linha), visível no commit sem abrir o log
    [ -n "${GITHUB_ACTIONS:-}" ] && echo "::error title=Atualização::$1 → $(printf '%s' "${2:-}" | tr '\n' ' ' | cut -c1-300)"
  fi
  return 0
}
running_tag() { docker inspect -f '{{.Config.Image}}' "$(docker compose ps -q uivo)" 2>/dev/null | sed 's/.*://'; }
cleanup() {
  (cd "$DIR/deploy" 2>/dev/null && docker compose down -v >/dev/null 2>&1)
  docker volume rm -f uivo-update-test_uivo-data-outro >/dev/null 2>&1
  docker rm -f uivo-update-registry >/dev/null 2>&1
  docker run --rm -v "$DIR:/d" alpine rm -rf /d/backups >/dev/null 2>&1
  rm -rf "$DIR"
}
trap cleanup EXIT

echo "== versões de teste num registro local"
docker run -d --rm --name uivo-update-registry -p "127.0.0.1:$REG_PORT:5000" registry:2.8.3 >/dev/null
docker build -q -t "$REG:build" "$REPO_DIR" >/dev/null || { echo "build da imagem falhou"; exit 1; }
publish() { # versão, compose.yml
  docker tag "$REG:build" "$REG:$1" && docker push -q "$REG:$1" >/dev/null && docker rmi "$REG:$1" >/dev/null
  mkdir -p "$DIR/raw/v$1/scripts"
  cp "$2" "$DIR/raw/v$1/compose.yml"
  cp "$REPO_DIR"/scripts/*.sh "$DIR/raw/v$1/scripts/"
}
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$REG_PORT/v2/" >/dev/null 2>&1 && break; sleep 1; done
publish "$FROM" "$REPO_DIR/compose.yml"
publish "$TO" "$REPO_DIR/compose.yml"
# 0.0.3: saudável, mas aponta para outro volume de dados (banco vazio) → tem que voltar
sed 's/uivo-data/uivo-data-outro/g' "$REPO_DIR/compose.yml" >"$DIR/compose-vazio.yml"
publish 0.0.3 "$DIR/compose-vazio.yml"

echo "== pasta de deploy simulada, começando na $FROM"
mkdir -p "$DIR/deploy"
cp "$REPO_DIR"/scripts/{update.sh,backup.sh} "$DIR/deploy/"
cd "$DIR/deploy" || exit 1
cp "$DIR/raw/v$FROM/compose.yml" compose.yml
printf 'AUTH_SECRET=%s\nUIVO_IMAGE=%s\nUIVO_TAG=%s\nUIVO_PORT=127.0.0.1:%s\n' "$(openssl rand -hex 32)" "$REG" "$FROM" "$PORT" >.env
docker compose up -d --no-build >/dev/null 2>&1
for _ in $(seq 1 60); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -c jar -H 'content-type: application/json' -d '{"email":"t@example.com","password":"senha-de-teste-123"}' "http://127.0.0.1:$PORT/api/setup" >/dev/null
curl -fsS -b jar -H 'content-type: application/json' -d '{"name":"Teste","url":"http://127.0.0.1:3000/healthz","check_domain":false}' "http://127.0.0.1:$PORT/api/sites" >/dev/null
ok "rodando na $FROM" "$([ "$(running_tag)" = "$FROM" ] && echo true || running_tag)"

restore_scripts() { cp "$REPO_DIR"/scripts/{update.sh,backup.sh} .; }

echo "== 1. atualização normal ($FROM → $TO)"
echo "# marcador da versão antiga" >>backup.sh
out=$(./update.sh "$TO" 2>&1); code=$?
ok "scripts de operação trocados pelos da versão instalada" "$(! grep -q 'marcador da versão antiga' backup.sh && echo true)"
restore_scripts
ok "update.sh terminou sem erro" "$([ $code = 0 ] && echo true || echo "código $code: $(echo "$out" | tail -3)")"
ok "agora na $TO" "$([ "$(running_tag)" = "$TO" ] && echo true || running_tag)"
ok ".env com UIVO_TAG=$TO" "$(grep -qx "UIVO_TAG=$TO" .env && echo true)"
ok "backup feito antes de atualizar" "$(ls "$BACKUP_DIR"/uivo-*.db.gz >/dev/null 2>&1 && echo true)"
ok "dados preservados (site continua cadastrado)" "$(curl -fsS -b jar "http://127.0.0.1:$PORT/api/sites" | grep -q '"name":"Teste"' && echo true)"

echo "== 2. versão inexistente (nada pode mudar)"
out=$(./update.sh 9.9.9 2>&1); code=$?
ok "recusada com erro" "$([ $code != 0 ] && echo true)"
ok "continua na $TO" "$([ "$(running_tag)" = "$TO" ] && echo true || running_tag)"
ok "compose.yml e .env intactos" "$([ ! -f compose.yml.bak ] && grep -qx "UIVO_TAG=$TO" .env && echo true)"
ok "nenhum backup feito para versão inexistente" "$([ "$(ls "$BACKUP_DIR"/uivo-*.db.gz | wc -l)" = 1 ] && echo true || ls "$BACKUP_DIR")"
out=$(./update.sh 'abc;rm -rf /' 2>&1); code=$?
ok "versão com formato inválido recusada" "$([ $code != 0 ] && echo "$out" | grep -q 'versão inválida' && echo true)"

echo "== 3. nova versão não fica saudável a tempo (rollback automático para $TO)"
out=$(HEALTH_TIMEOUT=1 ./update.sh "$FROM" 2>&1); code=$?
restore_scripts
ok "update.sh sinaliza a falha" "$([ $code != 0 ] && echo true)"
ok "mensagem de rollback concluído" "$(echo "$out" | grep -q 'rollback concluído' && echo true || echo "$out" | tail -2)"
ok "voltou para a $TO e está saudável" "$([ "$(running_tag)" = "$TO" ] && curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null && echo true || running_tag)"
ok ".env restaurado (UIVO_TAG=$TO)" "$(grep -qx "UIVO_TAG=$TO" .env && echo true)"

echo "== 4. nova versão sobe saudável, mas sem os dados (rollback automático para $TO)"
out=$(./update.sh 0.0.3 2>&1); code=$?
restore_scripts
ok "update.sh sinaliza a falha" "$([ $code != 0 ] && echo true)"
ok "motivo explicado (subiu sem os dados)" "$(echo "$out" | grep -q 'subiu sem os dados (antes 1 sites, agora 0)' && echo true || echo "$out" | tail -3)"
ok "voltou para a $TO com o compose original" "$([ "$(running_tag)" = "$TO" ] && ! grep -q uivo-data-outro compose.yml && echo true || running_tag)"
ok "dados de volta (site continua cadastrado)" "$(curl -fsS -b jar "http://127.0.0.1:$PORT/api/sites" | grep -q '"name":"Teste"' && echo true)"

echo
if [ "$FAILS" = 0 ]; then echo "Tudo certo."; else echo "$FAILS falha(s)."; fi
exit "$FAILS"
