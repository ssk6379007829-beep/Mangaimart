/**
 * The AI image prompt sellers (and the admin) can copy next to the hero banner
 * upload. The flow it's written for: paste this into ChatGPT — or any image AI —
 * *together with your own product photo*, let it generate the banner, then
 * upload the result into the ad.
 *
 * It is deliberately generic — it says "the uploaded image" rather than naming
 * any garment — so it works for whatever product photo the seller pastes in.
 * The composition it asks for matches the live hero: a wide 16:9 landscape with
 * the model on the RIGHT and clean negative space on the LEFT, because the hero
 * darkens the left and stacks the headline, subtext and button there.
 */
export const HERO_AD_IMAGE_PROMPT = [
  'Transform this exact uploaded image into a premium wide hero banner for a fashion ad (16:9 landscape, about 1792 × 1024 px).',
  "Keep the same model, outfit, pose, expression and styling, and preserve the garment's exact colours, print and fabric textures with realistic detail.",
  'Extend the image horizontally with realistic outpainting.',
  'Replace the background with a bright luxury boutique setting — elegant cream stone architecture, soft blooming flowers, gentle greenery, warm natural daylight and a refined lifestyle atmosphere.',
  'Position the model on the RIGHT side of the frame, leaving clean negative space on the LEFT for text.',
  'Add soft cinematic lighting, shallow depth of field, premium fashion-editorial colour grading, and a subtle dark-to-transparent gradient on the left for text readability.',
  'Luxury ethnic-wear fashion campaign, Vogue editorial style, ultra-realistic, 8K. No text, no logos, no watermark.',
].join(' ');
