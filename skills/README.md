# skills/

Prompts de cada etapa do Forge, um `SKILL.md` por etapa:

```
skills/
  grill/SKILL.md
  recon/SKILL.md
  tasks/SKILL.md
  dev/SKILL.md
  review/SKILL.md
  lessons/SKILL.md
```

Formato: frontmatter com `name` e `description`, depois o corpo em Markdown. Quando o texto é adaptado de terceiros, o frontmatter também traz a origem:

```markdown
---
name: grill
description: Entrevista o usuário, uma pergunta por vez, até não restar dúvida.
source: https://github.com/mattpocock/skills
source_skill: grill-with-docs
license: MIT
adapted: false
---

<instruções da etapa>
```

## Origem e atribuição

Parte do texto é adaptada de skills open source sob licença MIT:

- [`mattpocock/skills`](https://github.com/mattpocock/skills), de Matt Pocock
- [`backnotprop/pstack`](https://github.com/backnotprop/pstack), de Lauren Tan
- [`addyosmani/agent-skills`](https://github.com/addyosmani/agent-skills), de Addy Osmani

Os avisos de copyright e as licenças completas estão em [`../THIRD_PARTY_LICENSES.md`](../THIRD_PARTY_LICENSES.md).

## Regras

- `adapted: false` significa cópia literal do corpo original, ainda sem ajuste ao fluxo do Forge. Ao adaptar, trocar para `adapted: true`. A skill só deve ser carregada por uma etapa depois de adaptada.
- Toda skill adaptada declara `source`, `source_skill` e `license: MIT`. Quando a skill junta mais de uma origem (como a `recon`), o frontmatter usa `sources:` com uma lista de pares `source` e `source_skill`. O que for escrito do zero não leva esses campos.
- Se uma nova fonte for usada, adicionar a licença dela em `THIRD_PARTY_LICENSES.md` antes de commitar.
- Conteúdo genérico. Nada de empregador ou de terceiros privados (código, sistemas, contexto interno).
- Cada etapa lê só a própria skill; o que for critério comum (padrão do projeto, compatibilidade, contexto, nada quebra) é repetido em cada arquivo.
- O código só carrega o arquivo (`src/skills.ts`); nenhum prompt fica embutido em `steps/*.ts`.

Ver `DESIGN.md`, seção 4.12.
