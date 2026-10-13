import {
  DownloadOptions,
  DownloadResult,
  DeleteOptions,
  ExistsOptions,
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
   * @param options - `bucket` for an object outside the default bucket.
   *   Providers with a single container ignore it.
   */
  delete(key: string, options?: DeleteOptions): Promise<void>;

  /**
   * Get the public URL for a file
   * @param key - Storage key of the file
   * @returns Public URL of the file
   */
  getUrl(key: string, options?: GetUrlOptions): Promise<string>;

  /**
   * Check if a file exists in storage
   * @param key - Storage key of the file
   * @param options - Which bucket to look in, when not the default one
   * @returns True if file exists, false otherwise
   */
  exists(key: string, options?: ExistsOptions): Promise<boolean>;

  /**
   * Read a file's bytes back.
   *
   * Needed so KYC documents can be streamed through an authenticated route
   * instead of being handed to the browser as a signed url. Providers that
   * cannot do this throw — no KYC deployment runs on them.
   *
   * @param key - Storage key of the file
   * @param options - Which bucket to read from, when not the default one
   */
  download(key: string, options?: DownloadOptions): Promise<DownloadResult>;
}
