#!/usr/bin/env bash
# Porta de entrada do deploy automático (comando forçado da chave SSH do CI).
#
# No servidor, a chave de deploy fica no ~/.ssh/authorized_keys assim:
#   command="/opt/uptrue/deploy-entry.sh",restrict ssh-ed25519 AAAA... deploy-uptrue
#
# "restrict" desliga terminal, túneis e encaminhamentos; "command=" faz com que essa chave
# SÓ execute este script, seja qual for o comando pedido. O comando pedido chega em
# SSH_ORIGINAL_COMMAND e só é aceito se for uma versão (ex.: 0.1.7). Mesmo que a chave
# vaze, o máximo possível é instalar uma versão já publicada.
set -euo pipefail

requested="${SSH_ORIGINAL_COMMAND:-}"
if [[ ! "$requested" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "deploy recusado: esperado uma versão (ex.: 0.1.7)" >&2
  exit 1
fi
exec "$(dirname "$0")/update.sh" "$requested"
