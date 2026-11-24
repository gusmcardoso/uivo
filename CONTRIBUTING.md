# Contribuindo com o Uivo

## Versionamento

O projeto está em **desenvolvimento** (`0.x`). As versões seguem `v0.MINOR.PATCH`:

| Mudança | Exemplo | Quando |
| --- | --- | --- |
| **PATCH** | `v0.1.3` → `v0.1.4` | Cada entrega: recurso novo, correção, melhoria |
| **MINOR** | `v0.1.x` → `v0.2.0` | Só em upgrade significativo (mudança grande de escopo ou de arquitetura) |
| **1.0.0** | | Quando estiver estável para uso em produção por terceiros |

Cada tag `v*` passa pelo CI completo e publica `ghcr.io/gusmcardoso/uivo:<versão>` e `:0.<minor>` (sempre a última da série);
a `main` publica `:latest`. Tags publicadas não são movidas: correção vira uma versão nova.

## Branches

| Branch | Uso |
| --- | --- |
| `main` | Sempre estável: só recebe código com o CI verde |
| `feat/<assunto>` | Recurso novo (`feat/relatorio-pdf`) |
| `fix/<assunto>` | Correção (`fix/timeout-redirect`) |
| `ci/<assunto>` | Pipeline e infraestrutura |
| `docs/<assunto>` | Documentação |
| `chore/<assunto>` | Manutenção (versões, limpeza) |
| `dependabot/...` | Criadas automaticamente pelo Dependabot (um PR agrupado por ecossistema) |

Branches são curtas: abrem, passam no CI, entram na `main` e são apagadas.

## Commits

Padrão [Conventional Commits](https://www.conventionalcommits.org/pt-br/), em português:
`feat:`, `fix:`, `ci:`, `docs:`, `test:`, `chore:`, `deps:`. Exemplo: `fix(ci): checagem de porta independente da versão do Compose`.

## Antes de abrir um PR

```bash
npm run lint && npm run typecheck && npm test && npm run build
bash scripts/test-observability.sh   # se mexer no perfil de observabilidade
docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:v0.10.0 --severity=warning scripts/*.sh   # se mexer em scripts
```
