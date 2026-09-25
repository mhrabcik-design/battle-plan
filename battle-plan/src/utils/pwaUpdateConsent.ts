/** Consent belongs to this tab, even when another tab activates the worker. */
export function createPwaUpdateConsent(activate: () => void, reload: () => void) {
  let accepted = false;
  let activated = false;
  return {
    accept() {
      accepted = true;
      if (activated) reload();
      else activate();
    },
    controlling() {
      activated = true;
      if (accepted) reload();
    },
  };
}
