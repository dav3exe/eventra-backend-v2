import { Request, Response } from 'express'
import { sendTsRestError, sendTsRestSuccess } from '../utils/response-handler.js'
import tryCatchWrapper from '../utils/try-catch-wrapper.js'
import { CloudinaryService } from '../services/cloudinary.service.js'

export const uploadEventCoverImage = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!req.file) {
    return sendTsRestError(res, 400, 'No image file provided (expected field name "image")')
  }

  try {
    const uploaded = await CloudinaryService.uploadImage(req.file.buffer, 'event-covers')

    return sendTsRestSuccess(res, 201, {
      success: true,
      message: 'Image uploaded',
      body: uploaded,
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Image upload failed')
  }
})

// Reuses the same square/face-crop transform as user avatars (uploadAvatar,
// not the 16:9 uploadImage used for event covers) — lineup photos render as
// circular headshots on the event page, same as an avatar does.
export const uploadLineupPhoto = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!req.file) {
    return sendTsRestError(res, 400, 'No image file provided (expected field name "image")')
  }

  try {
    const uploaded = await CloudinaryService.uploadAvatar(req.file.buffer, 'lineup-photos')

    return sendTsRestSuccess(res, 201, {
      success: true,
      message: 'Image uploaded',
      body: uploaded,
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Image upload failed')
  }
})

// Same 16:9-friendly transform as the cover image, not the avatar crop —
// gallery photos display as a grid of full images, not headshots.
export const uploadGalleryPhoto = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!req.file) {
    return sendTsRestError(res, 400, 'No image file provided (expected field name "image")')
  }

  try {
    const uploaded = await CloudinaryService.uploadImage(req.file.buffer, 'event-gallery')

    return sendTsRestSuccess(res, 201, {
      success: true,
      message: 'Image uploaded',
      body: uploaded,
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Image upload failed')
  }
})

// Screenshots an attendee attaches to a refund request as evidence (see
// RefundsForm/refunds-form.tsx). No crop/resize beyond the standard
// upload-image size limit — a screenshot needs to stay legible, not fit a
// fixed aspect ratio, so this uses uploadImage's 16:9-limit transform
// rather than the avatar face-crop.
export const uploadRefundEvidence = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!req.file) {
    return sendTsRestError(res, 400, 'No image file provided (expected field name "image")')
  }

  try {
    const uploaded = await CloudinaryService.uploadImage(req.file.buffer, 'refund-evidence')

    return sendTsRestSuccess(res, 201, {
      success: true,
      message: 'Image uploaded',
      body: uploaded,
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Image upload failed')
  }
})

export const uploadReportEvidence = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!req.file) {
    return sendTsRestError(res, 400, 'No image file provided (expected field name "image")')
  }

  try {
    const uploaded = await CloudinaryService.uploadImage(req.file.buffer, 'report-evidence')

    return sendTsRestSuccess(res, 201, {
      success: true,
      message: 'Image uploaded',
      body: uploaded,
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Image upload failed')
  }
})

// One document type per Cloudinary subfolder, so the three verification
// documents (CAC certificate, director ID, proof of address) don't land in
// the same bucket as each other — makes them easy to tell apart from the
// Cloudinary side if anyone ever needs to.
const VERIFICATION_DOCUMENT_FOLDERS: Record<string, string> = {
  cacCertificate: 'verification-documents/cac-certificate',
  directorId: 'verification-documents/director-id',
  proofOfAddress: 'verification-documents/proof-of-address',
}

// Organizer verification documents (CAC certificate / director ID / proof
// of address) — uploaded during onboarding's dedicated verification step.
// One endpoint shared by all three; the frontend calls it once per document
// with a different `documentType` field each time. Uses documentUpload
// (PDF + image, larger size cap) rather than imageUpload, and
// uploadDocument (no crop/resize) rather than uploadImage/uploadAvatar.
export const uploadVerificationDocument = tryCatchWrapper(async (req: Request, res: Response) => {
  if (!req.file) {
    return sendTsRestError(res, 400, 'No file provided (expected field name "document")')
  }

  const documentType = req.body.documentType as string | undefined
  const folder = documentType ? VERIFICATION_DOCUMENT_FOLDERS[documentType] : undefined
  if (!folder) {
    return sendTsRestError(
      res,
      400,
      'Invalid or missing documentType (expected "cacCertificate", "directorId", or "proofOfAddress")'
    )
  }

  try {
    const uploaded = await CloudinaryService.uploadDocument(req.file.buffer, folder)

    return sendTsRestSuccess(res, 201, {
      success: true,
      message: 'Document uploaded',
      body: uploaded,
    })
  } catch (error: any) {
    return sendTsRestError(res, 502, error.message || 'Document upload failed')
  }
})
