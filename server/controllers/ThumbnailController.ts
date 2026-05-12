import { Request, Response } from 'express';
import Thumbnail from '../models/Thumbnail.js';
import ai from '../configs/ai.js';
import fs from 'fs';
import path from 'path';
import {v2 as cloudinary} from 'cloudinary';
import { InferenceClient } from '@huggingface/inference';

const stylePrompts = {
    'Bold & Graphic': 'eye-catching thumbnail, bold typography, vibrant colors, expressive facial reaction, dramatic lighting, high contrast, click-worthy composition, professional style',
    'Tech/Futuristic': 'futuristic thumbnail, sleek modern design, digital UI elements, glowing accents, holographic effects, cyber-tech aesthetic, sharp lighting, high-tech atmosphere',
    'Minimalist': 'minimalist thumbnail, clean layout, simple shapes, limited color palette, plenty of negative space, modern flat design, clear focal point',
    'Photorealistic': 'photorealistic thumbnail, ultra-realistic lighting, natural skin tones, candid moment, DSLR-style photography, lifestyle realism, shallow depth of field',
    'Illustrated': 'illustrated thumbnail, custom digital illustration, stylized characters, bold outlines, vibrant colors, creative cartoon or vector art style',
}

const colorSchemeDescriptions = {
    vibrant: 'vibrant and energetic colors, high saturation, bold contrasts, eye-catching palette',
    sunset: 'warm sunset tones, orange pink and purple hues, soft gradients, cinematic glow',
    forest: 'natural green tones, earthy colors, calm and organic palette, fresh atmosphere',
    neon: 'neon glow effects, electric blues and pinks, cyberpunk lighting, high contrast glow',
    purple: 'purple-dominant color palette, magenta and violet tones, modern and stylish mood',
    monochrome: 'black and white color scheme, high contrast, dramatic lighting, timeless aesthetic',
    ocean: 'cool blue and teal tones, aquatic color palette, fresh and clean atmosphere',
    pastel: 'soft pastel colors, low saturation, gentle tones, calm and friendly aesthetic',
}

export const generateThumbnail = async (req: Request, res: Response) => {
    try {
        const { userId } = req.session;
        const { title, prompt: user_prompt, style, aspect_ratio, color_scheme, text_overlay } = req.body;

        const thumbnail = await Thumbnail.create({
            userId,
            title,
            prompt_used: user_prompt,
            user_prompt,
            style,
            aspect_ratio,
            color_scheme,
            text_overlay,
            isGenerating: true
        });

        // STEP 1: Use Groq to generate an enhanced image prompt
        let basePrompt = `Create a ${stylePrompts[style as keyof typeof stylePrompts]} for: "${title}"`;

        if (color_scheme) {
            basePrompt += ` Use a ${colorSchemeDescriptions[color_scheme as keyof typeof colorSchemeDescriptions]} color scheme.`;
        }
        if (user_prompt) {
            basePrompt += ` Additional details: ${user_prompt}.`;
        }
        basePrompt += ` The thumbnail should be ${aspect_ratio}, visually stunning, and designed to maximize click-through rate. Make it bold, professional, and impossible to ignore.`;

        // Ask Groq to enhance the prompt for image generation
        const groqResponse = await ai.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert at writing detailed image generation prompts for YouTube thumbnails. Given a description, write a detailed, vivid image generation prompt. Return only the prompt text, nothing else.'
                },
                {
                    role: 'user',
                    content: basePrompt
                }
            ],
            max_tokens: 300
        });

        const enhancedPrompt = groqResponse.choices[0].message.content || basePrompt;

        // STEP 2: Use Hugging Face to generate the actual image
        const hfClient = new InferenceClient(process.env.HUGGINGFACE_API_KEY as string);

        const imageResult = await hfClient.textToImage({
            model: 'black-forest-labs/FLUX.1-dev',
            inputs: enhancedPrompt,
            provider: 'wavespeed',
        });

        // STEP 3: Save image to disk
        let finalBuffer: Buffer;

        if (typeof imageResult === 'string') {
            const base64Data = imageResult.includes('base64,')
                ? imageResult.split('base64,')[1]
                : imageResult;
            finalBuffer = Buffer.from(base64Data, 'base64');
        } else if (Buffer.isBuffer(imageResult)) {
            finalBuffer = imageResult;
        } else if (ArrayBuffer.isView(imageResult)) {
            const view = imageResult as ArrayBufferView;
            finalBuffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
        } else if (imageResult && typeof imageResult === 'object') {
            const arrayBuffer = await (imageResult as Blob).arrayBuffer();
            finalBuffer = Buffer.from(arrayBuffer);
        } else {
            throw new Error('Unexpected image result type from Hugging Face');
        }

        // Save to temp file
        const tempDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
        const filePath = path.join(tempDir, `thumbnail_${thumbnail._id}.png`);
        fs.writeFileSync(filePath, finalBuffer);

        // STEP 4: Upload to Cloudinary WITH text overlay
        const safeTitle = title.toUpperCase().replace(/[^a-zA-Z0-9 ]/g, '');

        const uploadResult = await cloudinary.uploader.upload(filePath, {
            resource_type: 'image',
            transformation: [
                // Dark gradient at bottom for text visibility
                {
                    overlay: {
                        font_family: 'Arial',
                        font_size: 70,
                        font_weight: 'bold',
                        text: safeTitle,
                        text_align: 'center',
                    },
                    color: '#FFFFFF',
                    gravity: 'south',
                    y: 60,
                    width: 900,
                    crop: 'fit',
                    effect: 'shadow:50',
                },
                {
                    flags: 'layer_apply',
                    gravity: 'south',
                    y: 60,
                },
            ]
        });

        thumbnail.image_url = uploadResult.url;
        thumbnail.isGenerating = false;
        await thumbnail.save();

        res.json({ message: 'Thumbnail Generated', thumbnail });

        // STEP 5: Remove temp file
        fs.unlinkSync(filePath);

    } catch (error: any) {
        console.log(error);
        res.status(500).json({ message: error.message });
    }
}

// Controllers For Thumbnail Deletion
export const deleteThumbnail = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { userId } = req.session;

        await Thumbnail.findByIdAndDelete({ _id: id, userId });

        res.json({ message: 'Thumbnail Deleted successfully' });

    } catch (error: any) {
        console.log(error);
        res.status(500).json({ message: error.message });
    }
}