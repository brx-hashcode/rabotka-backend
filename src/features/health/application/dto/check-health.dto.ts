export class CheckHealthDto {
  enableDiskCheck?: boolean;
  diskThresholdPercent?: number;

  constructor(enableDiskCheck = true, diskThresholdPercent = 0.98) {
    this.enableDiskCheck = enableDiskCheck;
    this.diskThresholdPercent = diskThresholdPercent;
  }
}
