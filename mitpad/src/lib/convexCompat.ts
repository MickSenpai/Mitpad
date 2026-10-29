export function isMissingLegacyWorkspaceLink(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /Could not find public function for ['"]web:vincularDatosAnteriores['"]/.test(detail);
}
