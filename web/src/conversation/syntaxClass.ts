/** The token-colour classes shared by every syntax-coloured surface (run_code's script, JSON tool results). */
export const SYNTAX_CLASS = {
  comment: 'text-muted-foreground italic',
  string: 'text-success',
  number: 'text-info',
  keyword: 'text-plan',
  key: 'text-primary',
} as const;
