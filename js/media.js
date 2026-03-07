// EXIF metadata stripping and photo sanitization
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

/**
 * Re-encode a received photo data URL through canvas.
 * Strips any embedded exploits, enforces size and dimension limits.
 * @param {string} dataUrl - Base64 data URL from a peer
 * @param {number} maxBytes - Maximum output size in bytes (default 200KB)
 * @returns {Promise<string>} Clean JPEG data URL
 */
export function reencodePhoto(dataUrl, maxBytes = 200 * 1024) {
    return new Promise((resolve, reject) => {
        if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
            reject(new Error('Invalid photo data'));
            return;
        }

        // Reject obviously oversized input (base64 is ~33% larger than binary)
        if (dataUrl.length > maxBytes * 3) {
            reject(new Error('Photo exceeds size limit'));
            return;
        }

        const img = new Image();

        const timeout = setTimeout(() => {
            img.src = '';
            reject(new Error('Photo decode timed out'));
        }, 5000);

        img.onload = () => {
            clearTimeout(timeout);

            // Reject decompression bombs
            const maxDim = 4096;
            if (img.width > maxDim || img.height > maxDim || img.width * img.height > 16777216) {
                reject(new Error('Photo dimensions exceed limit'));
                return;
            }

            // Scale down large images
            let { width, height } = img;
            const targetMaxDim = 2048;
            if (width > targetMaxDim || height > targetMaxDim) {
                const scale = targetMaxDim / Math.max(width, height);
                width = Math.round(width * scale);
                height = Math.round(height * scale);
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            let result = canvas.toDataURL('image/jpeg', 0.85);
            let approxBytes = (result.length - result.indexOf(',') - 1) * 0.75;

            if (approxBytes > maxBytes) {
                result = canvas.toDataURL('image/jpeg', 0.5);
                approxBytes = (result.length - result.indexOf(',') - 1) * 0.75;
                if (approxBytes > maxBytes) {
                    reject(new Error('Photo exceeds size limit after compression'));
                    return;
                }
            }

            resolve(result);
        };

        img.onerror = () => {
            clearTimeout(timeout);
            reject(new Error('Failed to decode photo'));
        };

        img.src = dataUrl;
    });
}
