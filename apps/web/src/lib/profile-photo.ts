const inputLimit = 10 * 1024 * 1024;
const uploadLimit = 512 * 1024;

/** Resize/re-encode locally; the API independently validates every uploaded byte. */
export async function prepareProfilePhoto(file: File): Promise<{ contentType: string; data: string }> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG or WebP image.");
  if (!file.size || file.size > inputLimit) throw new Error("Choose an image up to 10 MiB.");
  let image: ImageBitmap;
  try { image = await createImageBitmap(file); }
  catch { throw new Error("This image could not be opened. Try another PNG, JPEG or WebP file."); }
  let blob: Blob;
  try {
    if (!image.width || !image.height || image.width > 16384 || image.height > 16384 || image.width * image.height > 40_000_000) {
      throw new Error("Choose an image no larger than 40 megapixels.");
    }
    const canvas = document.createElement("canvas");
    const side = Math.min(image.width, image.height);
    canvas.width = canvas.height = Math.min(side, 512);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image resizing is unavailable in this browser.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("Could not prepare the photo.")), "image/jpeg", 0.88));
  } finally { image.close(); }
  if (blob.size > uploadLimit) throw new Error("The resized photo exceeds 512 KiB. Choose a smaller image.");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read the photo."));
    reader.readAsDataURL(blob);
  });
  return { contentType: blob.type, data };
}
