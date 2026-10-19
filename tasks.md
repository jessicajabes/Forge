# Tarefas

Backlog de construção do próprio Forge, escrito com a skill `tasks` a partir do `DESIGN.md` (a spec). Não há `context.md` nem `lessons.md`: o repo ainda não tem código. Os comandos `npm test`, `npm run typecheck` e `npm run lint` passam a existir na T3. Antes dela, os critérios usam observações diretas.

## T1: Validar o isolamento do `claude -p`
- **Arquivos**: `DESIGN.md` (seção 9)
- **O que fazer**: Testar na versão instalada do `claude` quais flags fazem o `claude -p` ignorar settings, MCPs, hooks e skills do usuário e carregar só o `CLAUDE.md` do repo-alvo (4.3). Fazer isso num diretório de teste, em modo somente leitura. Registrar na seção 9 as flags validadas, as que não funcionaram e a versão testada. Não gravar nem imprimir credenciais.
- **Critério de aceite**:
  - [x] A seção 9 do `DESIGN.md` lista as flags de isolamento validadas e a versão do `claude`
  - [x] Um teste real mostra que, com as flags, uma skill ou MCP pessoal não é carregado e o `CLAUDE.md` do alvo é
  - [x] A seção 9 diz qual comportamento ainda não foi validado, se houver
- **Depende de**: nenhuma

## T2: Testar o bloqueio de `--deny-tool` no `copilot-cli`
- **Arquivos**: `DESIGN.md` (seções 4.6 e 9)
- **O que fazer**: Em diretório de teste, confirmar se `--deny-tool` bloqueia de verdade `git push`, `rm`, `curl` e `wget`, incluindo a sintaxe de prefixo `shell(rm:*)`. Registrar o resultado. Este teste libera ou mantém bloqueado o Dev no `copilot-cli` (4.6).
- **Critério de aceite**:
  - [x] Cada um dos quatro comandos foi tentado com `--deny-tool` e o resultado (bloqueado ou não) está na seção 9
  - [x] A seção 4.6 diz se o `copilot-cli` pode ou não editar, conforme o resultado
  - [x] Nenhum comando destrutivo rodou fora do diretório de teste
- **Depende de**: nenhuma

## T3: Esqueleto do projeto com `vitest`
- **Arquivos**: `package.json` (novo), `tsconfig.json` (novo), `eslint.config.js` (novo), `.prettierrc` (novo), `.gitignore` (novo)
- **O que fazer**: Criar o pacote TypeScript do Forge, com nome `@jessicajabes/forge`, com `vitest`, `eslint` (regras recomendadas do `typescript-eslint`) e `prettier`. Scripts `test`, `typecheck` (`tsc --noEmit`) e `lint` (`eslint` e `prettier --check`). `.gitignore` com `.env`, `node_modules` e `dist`, e um teste de fumaça em `test/smoke.test.ts`. O `LICENSE` já existe.
- **Critério de aceite**:
  - [x] `npm test` passa, com o teste de fumaça
  - [x] `npm run typecheck` sem erros
  - [x] `npm run lint` sem erros
  - [x] `.env` está no `.gitignore`
  - [x] O `package.json` tem `name` igual a `@jessicajabes/forge`
  - [x] `npm run lint` falha num arquivo mal formatado e passa depois de `prettier --write`
- **Depende de**: nenhuma

## T4: Tipo `Runner` e `Runner` falso
- **Arquivos**: `src/runner.ts` (novo), `test/fakeRunner.ts` (novo), `test/runner.test.ts` (novo)
- **O que fazer**: Definir o tipo `Runner` como na 4.2 (`prompt`, `files`, `canEdit`, devolvendo texto). Criar um `Runner` falso que devolve respostas prontas em ordem e registra as chamadas, para os testes do orquestrador.
- **Critério de aceite**:
  - [x] `npm test` passa, com teste novo que mostra o falso devolvendo as respostas na ordem e registrando `canEdit`
  - [x] `npm run typecheck` sem erros
  - [x] `npm run lint` sem erros
- **Depende de**: T3

## T5: Schemas e validação dos artefatos
- **Arquivos**: `src/artifacts.ts` (novo), `test/artifacts.test.ts` (novo)
- **O que fazer**: Validar `spec.md` (seções fixas) e `tasks.md` (campos fixos, `Depende de` só para números menores, seção opcional `## Dúvidas`). Estrutura quebrada devolve erro claro, para o Forge pedir de novo (4.1). Gravação atômica: o arquivo nunca fica meio escrito.
- **Critério de aceite**:
  - [x] `npm test` passa, com testes para `spec.md` e `tasks.md` válidos, estrutura quebrada e dependência para tarefa de número maior
  - [x] Teste prova que a gravação atômica não deixa arquivo parcial
  - [x] `npm run typecheck` sem erros
  - [x] `npm run lint` sem erros
- **Depende de**: T3

## T6: Carregador de skills
- **Arquivos**: `src/skills.ts` (novo), `test/skills.test.ts` (novo)
- **O que fazer**: Ler o `SKILL.md` da etapa em `skills/`, tirar o frontmatter e devolver o corpo (4.12). Recusar carregar uma skill com `adapted: false`.
- **Critério de aceite**:
  - [x] `npm test` passa, com testes para frontmatter removido, etapa inexistente e `adapted: false` recusada
  - [x] `npm run typecheck` sem erros
  - [x] `npm run lint` sem erros
- **Depende de**: T3

## T7: Configuração `.workflow.yml`
- **Arquivos**: `src/config.ts` (novo), `.workflow.example.yml` (novo), `test/config.test.ts` (novo)
- **O que fazer**: Carregar e validar o `.workflow.yml` com os padrões da 4.4 (`review_mode`, `max_review_cycles`, `max_lessons`, `max_context_tokens`, `subagents`, `dev.arena`, `claude.isolated`). Criar o exemplo com um modelo sugerido por etapa.
- **Critério de aceite**:
  - [x] `npm test` passa, com testes para arquivo ausente (usa padrões), campo inválido e `claude.isolated` padrão `true`
  - [x] O `.workflow.example.yml` é aceito pelo validador em um teste
  - [x] `npm run typecheck` sem erros
  - [x] `npm run lint` sem erros
- **Depende de**: T3

## T8: Pré-requisitos de execução
- **Arquivos**: `src/preflight.ts` (novo), `src/runs.ts` (novo), `test/preflight.test.ts` (novo)
- **O que fazer**: Implementar a 3.1.1: recusar sem TTY, fora de git, com árvore suja, em `main` ou `master`, e com lock de outra execução ativa. Criar `.workflow/runs/<data>-<slug>/` e acrescentar `.workflow/` e `.workflow.yml` ao `.git/info/exclude` sem duplicar. Os testes usam um repositório git temporário.
- **Critério de aceite**:
  - [ ] `npm test` passa, com um teste para cada recusa (sem TTY, sem git, árvore suja, `main`, lock ativo)
  - [ ] Teste prova que o `.git/info/exclude` não duplica a linha em duas execuções
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T3

## T9: Orquestrador mínimo ponta a ponta
- **Arquivos**: `src/orchestrator.ts` (novo), `src/steps/stub.ts` (novo), `test/orchestrator.test.ts` (novo)
- **O que fazer**: Rodar as seis etapas na ordem da seção 1 com o `Runner` falso e etapas de mentira, gravando os artefatos na pasta da execução. Ainda sem parada humana, arena, revisão com ciclos nem Lições reais.
- **Critério de aceite**:
  - [ ] `npm test` passa, com teste que mostra a ordem Grill, Reconhecimento, Tarefas, Dev, Revisão, Lições e os arquivos gravados na pasta da execução
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T4, T5, T8

## T10: Parada humana e estimativa de custo
- **Arquivos**: `src/steps/humanStop.ts` (novo), `src/costEstimate.ts` (novo), `test/humanStop.test.ts` (novo)
- **O que fazer**: Depois das Tarefas, mostrar o `tasks.md` (e `## Dúvidas`, se houver), uma linha de custo relativa (chamadas de Dev por lote e nº de lotes) e as opções `aprovar`, `editar`, `cancelar` e `rodar sem arena` (4.10). O Dev só começa depois de `aprovar`.
- **Critério de aceite**:
  - [ ] `npm test` passa, com um teste para cada opção, incluindo que `cancelar` não chama o Dev e `rodar sem arena` desliga o arena
  - [ ] Teste prova que a linha de custo muda com `review_mode: per_task`
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T9

## T11: Retomada da última execução
- **Arquivos**: `src/runs.ts`, `src/orchestrator.ts`, `test/resume.test.ts` (novo)
- **O que fazer**: `forge-jj` sem argumento retoma a última execução incompleta a partir dos artefatos já gravados, sem refazer etapas concluídas (4.1, 3.3).
- **Critério de aceite**:
  - [ ] `npm test` passa, com teste que interrompe após as Tarefas e retoma sem repetir Grill nem Reconhecimento
  - [ ] Sem execução incompleta, o Forge diz isso em uma linha
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T10

## T12: Runner `claude-cli`
- **Arquivos**: `src/runners/claude-cli.ts` (novo), `test/runners/claude-cli.test.ts` (novo)
- **O que fazer**: Rodar `claude -p` como subprocesso, no `cwd` do alvo, com `--output-format stream-json`, `--allowedTools`, `--max-turns` e as flags de isolamento validadas na T1 (4.3). Etapas somente leitura liberam só `Read`, `Grep` e `Glob`. Avisar qual credencial vale se `ANTHROPIC_API_KEY` estiver definida (4.5). Os testes cobrem a montagem dos argumentos, sem chamar o CLI.
- **Critério de aceite**:
  - [ ] `npm test` passa, com teste que confirma que `canEdit: false` nunca inclui `Edit`, `Write` nem `Bash`
  - [ ] Teste confirma as flags de isolamento e o aviso de `ANTHROPIC_API_KEY`
  - [ ] Um teste manual com o `claude` instalado devolve texto em modo somente leitura
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T1, T4

## T13: Disparo de subagentes
- **Arquivos**: `src/subagents.ts` (novo), `test/subagents.test.ts` (novo)
- **O que fazer**: Disparar subagentes (chamadas isoladas e somente leitura ao `Runner`) em paralelo, com limite `subagents.max_parallel`, saída malformada pedida de novo e escalada ao humano na terceira falha seguida, sem derrubar os que já terminaram (4.13).
- **Critério de aceite**:
  - [ ] `npm test` passa, com testes para paralelismo e limite, falha de um subagente sem derrubar os outros, saída malformada e a regra das três falhas
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T4

## T14: Etapa Reconhecimento
- **Arquivos**: `src/steps/recon.ts` (novo), `test/recon.test.ts` (novo)
- **O que fazer**: Gerar `context.md` na pasta da execução com a skill `recon`: um explicador em repo pequeno, três exploradores mais explicador em repo maior (4.9, 4.13). A execução `trivial` copia o último `context.md` e avisa a idade; sem anterior, gera um novo. `--refresh-context` força refazer.
- **Critério de aceite**:
  - [ ] `npm test` passa, com testes para repo pequeno (1 chamada), repo grande (3 exploradores e 1 explicador) e `trivial` com e sem `context.md` anterior
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T6, T9, T13

## T15: Etapa Grill
- **Arquivos**: `src/steps/grill.ts` (novo), `src/io.ts` (novo), `test/grill.test.ts` (novo)
- **O que fazer**: Implementar o loop da 4.8 com `readline` atrás de uma interface de entrada e saída, para testar sem terminal: uma pergunta por vez com recomendação, `chega`, `depois`, "não sei", voltar, rejeitar o spec e saída malformada. O `spec.md` só é gravado depois da confirmação.
- **Critério de aceite**:
  - [ ] `npm test` passa, com um teste para `chega`, `depois`, "não sei" (decisão provisória), voltar e rejeitar o spec
  - [ ] Teste prova que o `spec.md` não é gravado antes da confirmação
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T5, T6, T9

## T16: Rascunho do Grill e Ctrl+C
- **Arquivos**: `src/steps/grill.ts`, `test/grillDraft.test.ts` (novo)
- **O que fazer**: Ctrl+C salva `grill-draft.json` na pasta da execução. Na próxima execução, o Forge pergunta se continua ou recomeça. O rascunho é apagado quando o `spec.md` é gravado (4.8).
- **Critério de aceite**:
  - [ ] `npm test` passa, com teste de salvar o rascunho, continuar, recomeçar e apagar depois do `spec.md`
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T15

## T17: Etapa Tarefas e spec mínimo da `trivial`
- **Arquivos**: `src/steps/tasks.ts` (novo), `test/tasks.test.ts` (novo)
- **O que fazer**: Gerar `tasks.md` com a skill `tasks`, validar com os schemas e pedir de novo se vier malformado. Na `trivial`, uma chamada de leitura gera antes o `spec.md` mínimo, tudo `(provisória)` (3.2). Passar `lessons.md` à etapa quando existir.
- **Critério de aceite**:
  - [ ] `npm test` passa, com testes para `tasks.md` válido, malformado pedido de novo e `trivial` gerando spec provisório
  - [ ] Teste confirma que `lessons.md` entra no prompt só quando existe
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T5, T6, T9, T14

## T18: Adaptar a skill `dev`
- **Arquivos**: `skills/dev/SKILL.md`
- **O que fazer**: Adaptar a skill `dev` ao fluxo do Forge e trocar para `adapted: true`: ler `tasks.md`, `spec.md`, `context.md` e `lessons.md`, implementar só o lote atual, marcar as caixas `[x]`, usar só os comandos de `dev.allowed_commands` e não dar `git push` (4.6). Corpo em inglês, sem material de empregador.
- **Critério de aceite**:
  - [ ] `skills/dev/SKILL.md` tem `adapted: true`, `source`, `source_skill` e `license: MIT`
  - [ ] O corpo não cita `/build`, `tasks/todo.md` nem modo de plano
  - [ ] `src/skills.ts` carrega a skill sem recusar (teste da T6)
- **Depende de**: T6

## T19: Etapa Dev simples com branch e commit por lote
- **Arquivos**: `src/steps/dev.ts` (novo), `src/git.ts` (novo), `test/dev.test.ts` (novo)
- **O que fazer**: Criar a branch `forge/<slug>`, rodar o Dev (`claude-cli`, `canEdit: true`) por lote, rodar `dev.allowed_commands` e fazer um commit local por lote aprovado, sem `git push` (4.6, 4.7). O diff de cada lote vem dos commits. Os testes usam repositório git temporário e `Runner` falso.
- **Critério de aceite**:
  - [ ] `npm test` passa, com teste que confirma a branch `forge/<slug>`, um commit por lote e nenhum `push`
  - [ ] Teste mostra que `per_task` gera um lote por tarefa e `final`, um lote
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T12, T17, T18

## T20: Arena no Dev
- **Arquivos**: `src/arena.ts` (novo), `src/steps/dev.ts`, `test/arena.test.ts` (novo)
- **O que fazer**: Implementar a 4.14: rubrica, N worktrees, candidatos em paralelo, juiz somente leitura, base e enxerto, verificação e `arena.md`. Tratar desistência (N-1, 1 e 0), divergência total e convergência sem enxerto. Os worktrees saem ao fim. Ligado por padrão; desligado na `trivial` e com `rodar sem arena`.
- **Critério de aceite**:
  - [ ] `npm test` passa, com testes para criação e remoção dos worktrees, desistência (N-1, 1 e 0), divergência total e convergência sem enxerto
  - [ ] Teste confirma que os candidatos não recebem `git worktree` nem `git push`
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T13, T19

## T21: Etapa Revisão com ciclos
- **Arquivos**: `src/steps/review.ts` (novo), `test/review.test.ts` (novo)
- **O que fazer**: Disparar um revisor por modelo em paralelo, uma síntese com JSON validado e os quatro grupos, e escrever o `review.md` (4.13, 6.1). Reprovar com `act_on` ou `consider` e voltar ao Dev. Respeitar o limite de 3 ciclos e escalar direto ao humano quando um `act_on` for mantido.
- **Critério de aceite**:
  - [ ] `npm test` passa, com testes para aprovação, reprovação e retorno ao Dev, limite de ciclos e escalada de `act_on` mantido
  - [ ] Teste confirma que `noted` e `dismissed` não voltam ao Dev
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T13, T19

## T22: Adaptar a skill `lessons`
- **Arquivos**: `skills/lessons/SKILL.md`, `skills/lessons/references/judgment-reviewer.md` (novo), `skills/lessons/references/tooling-reviewer.md` (novo), `skills/lessons/references/divergent-reviewer.md` (novo), `skills/lessons/references/synthesizer.md` (novo)
- **O que fazer**: Adaptar a `reflect` da pstack e trocar para `adapted: true`. Manter as três lentes (Judgment, Tooling, Divergent) e o sintetizador com Accepted, Rejected e Backlog (4.13). Trocar a entrada: no lugar da transcrição da conversa, cada lente lê só arquivos da pasta da execução (`review.md`, `arena.md`, `tasks.md`, `spec.md`) e o diff dos commits do lote, nunca a conversa do Grill nem a transcrição da sessão do CLI. Trocar a saída: no lugar de edições de skills, propor lições de uma frase para o `lessons.md` (5.4, 6.2). Remover Cursor, MCPs, o arquivo de modelos da pstack e o tracker de devex. Escrever os quatro templates em `references/`, com a origem declarada.
- **Critério de aceite**:
  - [ ] `skills/lessons/SKILL.md` tem `adapted: true`, `source`, `source_skill` e `license: MIT`
  - [ ] O corpo não cita transcrição, Cursor, MCP, `poteto-mode` nem tracker de devex
  - [ ] Cada template de `references/` lista os arquivos que a lente pode ler, e nenhum é a conversa do Grill ou a transcrição da sessão
  - [ ] Os quatro arquivos de `references/` existem e cada lente tem o próprio template
  - [ ] A saída da skill é uma lista de linhas no formato do `lessons.md` (regra, data, tarefa de origem)
  - [ ] A seção 4.13 do `DESIGN.md` lista as três lentes
- **Depende de**: T6

## T23: Etapa Lições
- **Arquivos**: `src/steps/lessons.ts` (novo), `test/lessons.test.ts` (novo)
- **O que fazer**: Propor lições a partir do `review.md` e pedir `sim`, `não` ou `editar` para cada uma. Nada é gravado sem aprovação. Limite de 30 lições: ao passar, mostrar as antigas para remover ou juntar (6.2).
- **Critério de aceite**:
  - [ ] `npm test` passa, com testes para aprovar, recusar, editar e o limite de 30 lições
  - [ ] Teste prova que nada é gravado sem aprovação
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T9, T21, T22

## T24: Runner `copilot-cli`
- **Arquivos**: `src/runners/copilot-cli.ts` (novo), `test/runners/copilot-cli.test.ts` (novo)
- **O que fazer**: Rodar `copilot -p` com `-s` ou `--output-format json`, `--no-ask-user`, `--no-custom-instructions`, `--no-auto-update`, `--usage-output-file` e `--deny-tool write --deny-tool shell` nas etapas somente leitura (4.3). A T2 liberou o Dev: `canEdit: true` usa `--allow-tool write`, `--allow-tool 'shell(<comando>)'` por item de `dev.allowed_commands`, `--deny-tool` de prefixo para `git push`, `rm`, `curl` e `wget` e `--disallow-temp-dir` (4.6). Nunca `--allow-all`, `--allow-all-tools` nem `--yolo`.
- **Critério de aceite**:
  - [ ] `npm test` passa, com teste que confirma `--deny-tool write` e `--deny-tool shell` em somente leitura
  - [ ] Teste confirma que `--allow-all`, `--allow-all-tools` e `--yolo` nunca aparecem
  - [ ] Teste confirma que `canEdit: true` inclui `--allow-tool write`, os quatro `--deny-tool` de prefixo e `--disallow-temp-dir`
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T2, T4

## T25: CLI `forge-jj` e perguntas iniciais
- **Arquivos**: `src/index.ts` (novo), `package.json`, `test/cli.test.ts` (novo)
- **O que fazer**: Expor o comando `forge-jj "<tarefa>"` com as perguntas de tamanho e de modo de revisão (Enter escolhe o padrão) e as flags `--size`, `--review per_task`, `--no-arena`, `--arena <n>` e `--refresh-context` (3.2). Ligar o `preflight`, o orquestrador e os runners.
- **Critério de aceite**:
  - [ ] `npm test` passa, com teste que confirma que as flags pulam as perguntas e que Enter escolhe os padrões
  - [ ] `npm link` e `forge-jj --help` funcionam
  - [ ] Sem TTY, o comando recusa com uma linha
  - [ ] `npm run typecheck` sem erros
  - [ ] `npm run lint` sem erros
- **Depende de**: T10, T11, T12, T14, T15, T17, T19, T20, T21, T23, T24

## T26: README
- **Arquivos**: `README.md` (novo)
- **O que fazer**: Escrever o README em inglês: o que é o Forge, instalação, uso, os runners, o aviso de que cada pessoa usa o próprio login só para si e que o Forge não oferece login nem compartilha credenciais (seção 9), as três fontes das skills e o link para `THIRD_PARTY_LICENSES.md`.
- **Critério de aceite**:
  - [ ] O README tem o aviso de login pessoal e cita `mattpocock/skills`, `backnotprop/pstack` e `addyosmani/agent-skills`
  - [ ] Todo comando do README existe em `package.json` ou na CLI
  - [ ] Nenhuma menção a empregador, a sistemas ou a contexto interno
- **Depende de**: T25

## T27: Tarefas de referência manuais
- **Arquivos**: `test/manual/README.md` (novo), `test/manual/results.md` (novo)
- **O que fazer**: Montar 2 ou 3 tarefas reais de tamanhos diferentes em repositórios pessoais ou públicos. Para cada uma, rodar o Forge com arena, o Dev simples e o `claude` direto, e anotar custo relativo, ciclos de revisão e testes passando (seção 7).
- **Critério de aceite**:
  - [ ] `results.md` tem, por tarefa, as três configurações com custo relativo, nº de ciclos e se os testes passaram
  - [ ] `results.md` termina com a decisão: o arena continua como padrão ou não
- **Depende de**: T25

## T28: Checklist antes de publicar
- **Arquivos**: `DESIGN.md` (seção 11), `THIRD_PARTY_LICENSES.md`
- **O que fazer**: Antes de enviar ao GitHub e ao npm: toda skill adaptada tem `source` e a origem está em `THIRD_PARTY_LICENSES.md`, a checagem de IP com o empregador foi feita, os termos do GitHub para o `copilot-cli` foram lidos, e o escopo do pacote npm (`@jessicajabes/forge`) está disponível para publicar (2, 4.12 e 11).
- **Critério de aceite**:
  - [ ] Cada `SKILL.md` com `adapted: true` tem `source` e consta em `THIRD_PARTY_LICENSES.md`
  - [ ] A seção 11 registra a data e o resultado da checagem de IP e dos termos do GitHub
  - [ ] Nenhuma chave, `.env` ou menção a empregador no histórico a publicar
- **Depende de**: T26, T27
