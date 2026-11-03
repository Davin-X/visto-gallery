/**
 * Automatic update checks are opt-in. Manual Help > Check for Updates works
 * regardless, so a false result here only suppresses the launch request.
 */
export function shouldCheckForUpdatesOnLaunch(settings: {
  checkForUpdatesOnLaunch?: boolean;
}): boolean {
  return settings.checkForUpdatesOnLaunch === true;
}
