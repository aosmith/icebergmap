// EXIF metadata stripping for photos
// Decode image → re-encode to clean canvas → all metadata is gone

/**
 * Strip all EXIF/metadata from an image file.
 * Returns a clean JPEG blob with no GPS, camera info, timestamps, etc.
 * @param {File} file - Image file from file input
 * @returns {Promise<{ blob: Blob, dataUrl: string }>}
 */
export function stripMetadata(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            const img = new Image();

            img.onload = () => {
                // Draw to canvas — this strips ALL metadata
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;

                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                // Re-encode as JPEG (quality 0.85 — good quality, reasonable size)
                canvas.toBlob((blob) => {
                    if (!blob) {
                        reject(new Error('Failed to encode image'));
                        return;
                    }
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                    resolve({ blob, dataUrl });
                }, 'image/jpeg', 0.85);
            };

            img.onerror = () => reject(new Error('Failed to load image'));
            img.src = e.target.result;
        };

        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}
