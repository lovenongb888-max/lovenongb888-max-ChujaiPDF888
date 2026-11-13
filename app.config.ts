function getAppName(): string {
  const profile = process.env.EAS_BUILD_PROFILE;
  const platform = process.env.EAS_BUILD_PLATFORM;
  const appName = env.appName;

  // iOS ใช้ชื่อเดิมทุกโปรไฟล์
  if (platform === "ios") {
    return appName;
  }

  switch (profile) {
    case "staging":
      return `${appName} (Staging)`;
    case "production":
      return appName;
    case undefined:
      return `${appName} (Dev)`;
    default:
      throw new Error(`Unknown EAS_BUILD_PROFILE: ${profile}`);
  }
}
