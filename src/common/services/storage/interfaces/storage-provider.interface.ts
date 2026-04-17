import {
  GetUrlOptions,
  UploadOptions,
  UploadResult,
} from '../types/storage.types';

export interface IStorageProvider {
  /**
   * Upload a file to the storage provider
   * @param file - File buffer to upload
   * @param filename - Name of the file
   * @param options - Upload options (mimeType, folder, metadata, etc.)
   * @returns Upload result with key, url, and provider information
   */
  upload(
    file: Buffer,
    filename: string,
    options?: UploadOptions,
  ): Promise<UploadResult>;

  /**
   * Delete a file from the storage provider
   * @param key - Storage key of the file to delete
   */
  delete(key: string): Promise<void>;

  /**
   * Get the public URL for a file
   * @param key - Storage key of the file
   * @returns Public URL of the file
   */
  getUrl(key: string, options?: GetUrlOptions): Promise<string>;

  /**
   * Check if a file exists in storage
   * @param key - Storage key of the file
   * @returns True if file exists, false otherwise
   */
  exists(key: string): Promise<boolean>;
}
