/**
 * @relay/core — moteur de pipeline.
 *
 * Composants (remplis au fil des étapes v0.1) :
 *   decomposer → router → executor → monitor → metrics
 *
 * Pour l'instant, ce barrel n'exporte que la version du moteur ; les types
 * partagés et les composants arrivent aux étapes suivantes.
 */
export const CORE_VERSION = "0.1.0";
