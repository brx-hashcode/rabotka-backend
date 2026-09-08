import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  EXTENSION_FOR_MIME,
  IMAGE_UPLOAD_MAX_BYTES,
  isAllowedImageMimeType,
} from '../constants/image-upload';

/**
 * Multer options for a route that accepts images and nothing else.
 *
 * THROWS rather than `cb(null, false)`. Both styles exist in this repo: the
 * avatar and portfolio routes drop a rejected file silently, so the request
 * succeeds with fewer files than were sent and the user is told nothing;
 * `admin-profile`'s two image routes throw. Throwing is the right default — a
 * refused upload the uploader cannot see is worse than an error.
 */
export function imageMulterOptions(maxBytes: number = IMAGE_UPLOAD_MAX_BYTES) {
  return {
    limits: { fileSize: maxBytes },
    fileFilter: (
      _req: unknown,
      file: Express.Multer.File,
      cb: (error: Error | null, acceptFile: boolean) => void,
    ) => {
      if (!isAllowedImageMimeType(file.mimetype)) {
        cb(
          new BadRequestException('Only JPEG, PNG or WEBP images are allowed'),
          false,
        );
        return;
      }
      cb(null, true);
    },
  };
}

/**
 * The same file with a filename whose extension matches its validated mime type.
 *
 * `FileService.uploadToStorage` derives the stored key's extension from
 * `originalname`, which the client controls and nobody sanitises. Pass a file
 * through here first and the key can only ever end in an extension we accept,
 * whatever the upload was named.
 *
 * The basename is dropped entirely rather than cleaned: `uploadToStorage`
 * replaces it with `${Date.now()}_${random}` regardless, so nothing is lost and
 * there is no sanitiser to get subtly wrong.
 */
export function withSafeImageName(
  file: Express.Multer.File,
): Express.Multer.File {
  if (!isAllowedImageMimeType(file.mimetype)) {
    // Unreachable behind `imageMulterOptions`, but this function is the thing
    // standing between a mime type and a stored key — it does not get to assume
    // a caller wired the filter up.
    throw new BadRequestException('Only JPEG, PNG or WEBP images are allowed');
  }

  return Object.assign({}, file, {
    originalname: `image.${EXTENSION_FOR_MIME[file.mimetype]}`,
  });
}

/** Re-exported so a controller needs one import to declare an image route. */
export { ALLOWED_IMAGE_MIME_TYPES, IMAGE_UPLOAD_MAX_BYTES };
