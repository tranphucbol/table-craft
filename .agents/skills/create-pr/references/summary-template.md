# PR Summary Template

Generate the pull request summary following this exact structure. The producer loads the
horcrux `mr-description` profile before drafting; its voice rules are host-agnostic despite
the name (written for GitLab, apply unchanged to GitHub).

## Template

The structure lives in the repository, so a pull request opened in the GitHub web UI starts from
the same one: `.github/pull_request_template.md` at the repository root. Follow its headings in
order. Each `<!-- ... -->` comment is the guidance for its section: replace it with the content it
asks for and drop the comment. Keep the italic guidance sentence under "Verification & Testing"
verbatim.

## Closing Keywords

When a GitHub issue is the tracked context (`{issue_number}` from Step 1), add a line right after
the title-equivalent context — the first line of the "Description" subsection is the natural spot —
using a GitHub closing keyword so merging the PR closes the issue automatically:

```
Closes #{issue_number}
```

## Style

Voice and style come from the horcrux `mr-description` profile loaded by the producer. This template
owns structure and required content.

## Analysis Guidelines

### For Code Changes (any language):

- Identify new classes, methods, or interfaces added
- Note modifications to existing business logic
- Check for changes in exception handling
- Review service layer modifications
- Analyze controller/API endpoint changes

### For Configuration Changes:

- Review application properties modifications
- Check database configuration updates
- Analyze external service configurations
- Note environment-specific changes

### For Database Changes:

- Review SQL migration files
- Identify new tables, columns, or indexes
- Check for data migration scripts
- Analyze schema changes impact

### For API Changes:

- Identify new endpoints added
- Note modifications to existing endpoints
- Check request/response model changes
- Review authentication/authorization changes

## Output Constraints

- Target 100-500 words, excluding headings, diagrams, commands, checklists, links, and evidence artifacts. Keep the length proportional to the PR's complexity. Exceed 500 words only when necessary to preserve material risks, testing details, or deployment dependencies
- Key Changes section covers sufficient context but does NOT list every file — only significant changes grouped by intent
- Impact and Scope includes only scopes with material impact. Omit unaffected scopes entirely instead of stating that they have no changes or impact
- Problem statement is clear and specific
- Solution approach is well-explained
- Testing scenarios are relevant to changes
