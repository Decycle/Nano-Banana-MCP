#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  CallToolRequest,
  CallToolResult,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import fs from 'fs/promises'
import path from 'path'
import { config as dotenvConfig } from 'dotenv'

// Load environment variables
dotenvConfig()

const ConfigSchema = z.object({
  geminiApiKey: z
    .string()
    .min(1, 'Gemini API key is required'),
  workplacePath: z.string().optional(),
})

type Config = z.infer<typeof ConfigSchema>

class NanoBananaMCP {
  private server: Server
  private genAI: GoogleGenAI | null = null
  private config: Config | null = null
  private lastImagePath: string | null = null
  private configSource:
    | 'environment'
    | 'config_file'
    | 'not_configured' = 'not_configured'

  constructor() {
    this.server = new Server(
      {
        name: 'nano-banana-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    )

    this.setupHandlers()
  }

  private setupHandlers() {
    this.server.setRequestHandler(
      ListToolsRequestSchema,
      async () => {
        return {
          tools: [
            {
              name: 'configure_gemini_token',
              description:
                'Configure your Gemini API token for nano-banana image generation',
              inputSchema: {
                type: 'object',
                properties: {
                  apiKey: {
                    type: 'string',
                    description:
                      'Your Gemini API key from Google AI Studio',
                  },
                },
                required: ['apiKey'],
              },
            },
            {
              name: 'generate_image',
              description:
                'Generate a NEW image from text prompt. Use this ONLY when creating a completely new image, not when modifying an existing one.',
              inputSchema: {
                type: 'object',
                properties: {
                  prompt: {
                    type: 'string',
                    description:
                      'Text prompt describing the NEW image to create from scratch',
                  },
                  relative_save_path: {
                    type: 'string',
                    description:
                      'Optional relative path within the workplace directory to save the image (e.g., "subfolder/image.png")',
                  },
                },
                required: ['prompt'],
              },
            },
            {
              name: 'edit_image',
              description:
                'Edit a SPECIFIC existing image file, optionally using additional reference images. Use this when you have the exact file path of an image to modify.',
              inputSchema: {
                type: 'object',
                properties: {
                  imagePath: {
                    type: 'string',
                    description:
                      'Full file path to the main image file to edit',
                  },
                  prompt: {
                    type: 'string',
                    description:
                      'Text describing the modifications to make to the existing image',
                  },
                  relative_save_path: {
                    type: 'string',
                    description:
                      'Optional relative path within the workplace directory to save the edited image (e.g., "subfolder/edited.png")',
                  },
                  referenceImages: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                    description:
                      'Optional array of file paths to additional reference images to use during editing (e.g., for style transfer, adding elements, etc.)',
                  },
                },
                required: ['imagePath', 'prompt'],
              },
            },
            {
              name: 'get_configuration_status',
              description:
                'Check if Gemini API token is configured',
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
            {
              name: 'get_last_image_info',
              description:
                'Get information about the last generated/edited image in this session (file path, size, etc.). Use this to check what image is currently available for continue_editing.',
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          ] as Tool[],
        }
      }
    )

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (
        request: CallToolRequest
      ): Promise<CallToolResult> => {
        try {
          switch (request.params.name) {
            case 'configure_gemini_token':
              return await this.configureGeminiToken(
                request
              )


            case 'generate_image':
              return await this.generateImage(request)

            case 'edit_image':
              return await this.editImage(request)

            case 'get_configuration_status':
              return await this.getConfigurationStatus()


            case 'get_last_image_info':
              return await this.getLastImageInfo()

            default:
              throw new McpError(
                ErrorCode.MethodNotFound,
                `Unknown tool: ${request.params.name}`
              )
          }
        } catch (error) {
          if (error instanceof McpError) {
            throw error
          }
          throw new McpError(
            ErrorCode.InternalError,
            `Tool execution failed: ${
              error instanceof Error
                ? error.message
                : String(error)
            }`
          )
        }
      }
    )
  }

  private async configureGeminiToken(
    request: CallToolRequest
  ): Promise<CallToolResult> {
    const { apiKey } = request.params.arguments as {
      apiKey: string
    }

    try {
      ConfigSchema.parse({
        geminiApiKey: apiKey,
        workplacePath: this.config?.workplacePath,
      })

      this.config = {
        geminiApiKey: apiKey,
        workplacePath: this.config?.workplacePath,
      }
      this.genAI = new GoogleGenAI({ apiKey })
      this.configSource = 'config_file' // Manual configuration via tool

      return {
        content: [
          {
            type: 'text',
            text: '✅ Gemini API token configured successfully! You can now use nano-banana image generation features.',
          },
        ],
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid API key: ${error.errors[0]?.message}`
        )
      }
      throw error
    }
  }


  private async generateImage(
    request: CallToolRequest
  ): Promise<CallToolResult> {
    if (!this.ensureConfigured()) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Gemini API token not configured. Use configure_gemini_token first.'
      )
    }

    const { prompt, relative_save_path } = request.params.arguments as {
      prompt: string
      relative_save_path?: string
    }

    try {
      const response =
        await this.genAI!.models.generateContent({
          model: 'gemini-2.5-flash-image-preview',
          contents: prompt,
        })

      // Process response to extract image data
      const content: any[] = []
      const savedFiles: string[] = []
      let textContent = ''

      // Get appropriate save directory - use workplace path or current directory
      const workplaceDir = this.config?.workplacePath || process.cwd()
      const imagesDir = relative_save_path 
        ? path.join(workplaceDir, path.dirname(relative_save_path))
        : workplaceDir

      // Create directory
      await fs.mkdir(imagesDir, {
        recursive: true,
        mode: 0o755,
      })

      if (
        response.candidates &&
        response.candidates[0]?.content?.parts
      ) {
        for (const part of response.candidates[0].content
          .parts) {
          // Process text content
          if (part.text) {
            textContent += part.text
          }

          // Process image data
          if (part.inlineData?.data) {
            let fileName: string
            if (relative_save_path) {
              fileName = path.basename(relative_save_path)
            } else {
              const timestamp = new Date()
                .toISOString()
                .replace(/[:.]/g, '-')
              const randomId = Math.random()
                .toString(36)
                .substring(2, 8)
              fileName = `generated-${timestamp}-${randomId}.png`
            }
            const filePath = path.join(imagesDir, fileName)

            const imageBuffer = Buffer.from(
              part.inlineData.data,
              'base64'
            )
            await fs.writeFile(filePath, imageBuffer)
            savedFiles.push(filePath)
            this.lastImagePath = filePath

            // Add image to MCP response
            content.push({
              type: 'image',
              data: part.inlineData.data,
              mimeType:
                part.inlineData.mimeType || 'image/png',
            })
          }
        }
      }

      // Build response content
      let statusText = `🎨 Image generated with nano-banana (Gemini 2.5 Flash Image)!\n\nPrompt: "${prompt}"`

      if (textContent) {
        statusText += `\n\nDescription: ${textContent}`
      }

      if (savedFiles.length > 0) {
        statusText += `\n\n📁 Image saved to:\n${savedFiles
          .map((f) => `- ${f}`)
          .join('\n')}`
        statusText += `\n\n💡 View the image by:`
        statusText += `\n1. Opening the file at the path above`
        statusText += `\n2. Clicking on "Called generate_image" in Cursor to expand the MCP call details`
        statusText += `\n\n🔄 To modify this image, use: continue_editing`
        statusText += `\n📋 To check current image info, use: get_last_image_info`
      } else {
        statusText += `\n\nNote: No image was generated. The model may have returned only text.`
        statusText += `\n\n💡 Tip: Try running the command again - sometimes the first call needs to warm up the model.`
      }

      // Add text content first
      content.unshift({
        type: 'text',
        text: statusText,
      })

      return { content }
    } catch (error) {
      console.error('Error generating image:', error)
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to generate image: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      )
    }
  }

  private async editImage(
    request: CallToolRequest
  ): Promise<CallToolResult> {
    if (!this.ensureConfigured()) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Gemini API token not configured. Use configure_gemini_token first.'
      )
    }

    const { imagePath, prompt, relative_save_path, referenceImages } = request
      .params.arguments as {
      imagePath: string
      prompt: string
      relative_save_path?: string
      referenceImages?: string[]
    }

    try {
      // Prepare the main image
      const imageBuffer = await fs.readFile(imagePath)
      const mimeType = this.getMimeType(imagePath)
      const imageBase64 = imageBuffer.toString('base64')

      // Prepare all image parts
      const imageParts: any[] = [
        {
          inlineData: {
            data: imageBase64,
            mimeType: mimeType,
          },
        },
      ]

      // Add reference images if provided
      if (referenceImages && referenceImages.length > 0) {
        for (const refPath of referenceImages) {
          try {
            const refBuffer = await fs.readFile(refPath)
            const refMimeType = this.getMimeType(refPath)
            const refBase64 = refBuffer.toString('base64')

            imageParts.push({
              inlineData: {
                data: refBase64,
                mimeType: refMimeType,
              },
            })
          } catch (error) {
            // Continue with other images, don't fail the entire operation
            continue
          }
        }
      }

      // Add the text prompt
      imageParts.push({ text: prompt })

      // Use new API format with multiple images and text
      const response =
        await this.genAI!.models.generateContent({
          model: 'gemini-2.5-flash-image-preview',
          contents: [
            {
              parts: imageParts,
            },
          ],
        })

      // Process response
      const content: any[] = []
      const savedFiles: string[] = []
      let textContent = ''

      // Get appropriate save directory - use workplace path or current directory
      const workplaceDir = this.config?.workplacePath || process.cwd()
      const imagesDir = relative_save_path 
        ? path.join(workplaceDir, path.dirname(relative_save_path))
        : workplaceDir
      await fs.mkdir(imagesDir, {
        recursive: true,
        mode: 0o755,
      })

      // Extract image from response
      if (
        response.candidates &&
        response.candidates[0]?.content?.parts
      ) {
        for (const part of response.candidates[0].content
          .parts) {
          if (part.text) {
            textContent += part.text
          }

          if (part.inlineData) {
            // Save edited image
            let fileName: string
            if (relative_save_path) {
              fileName = path.basename(relative_save_path)
            } else {
              const timestamp = new Date()
                .toISOString()
                .replace(/[:.]/g, '-')
              const randomId = Math.random()
                .toString(36)
                .substring(2, 8)
              fileName = `edited-${timestamp}-${randomId}.png`
            }
            const filePath = path.join(imagesDir, fileName)

            if (part.inlineData.data) {
              const imageBuffer = Buffer.from(
                part.inlineData.data,
                'base64'
              )
              await fs.writeFile(filePath, imageBuffer)
              savedFiles.push(filePath)
              this.lastImagePath = filePath
            }

            // Add to MCP response
            if (part.inlineData.data) {
              content.push({
                type: 'image',
                data: part.inlineData.data,
                mimeType:
                  part.inlineData.mimeType || 'image/png',
              })
            }
          }
        }
      }

      // Build response
      let statusText = `🎨 Image edited with nano-banana!\n\nOriginal: ${imagePath}\nEdit prompt: "${prompt}"`

      if (referenceImages && referenceImages.length > 0) {
        statusText += `\n\nReference images used:\n${referenceImages
          .map((f) => `- ${f}`)
          .join('\n')}`
      }

      if (textContent) {
        statusText += `\n\nDescription: ${textContent}`
      }

      if (savedFiles.length > 0) {
        statusText += `\n\n📁 Edited image saved to:\n${savedFiles
          .map((f) => `- ${f}`)
          .join('\n')}`
        statusText += `\n\n💡 View the edited image by:`
        statusText += `\n1. Opening the file at the path above`
        statusText += `\n2. Clicking on "Called edit_image" in Cursor to expand the MCP call details`
        statusText += `\n\n🔄 To continue editing, use: continue_editing`
        statusText += `\n📋 To check current image info, use: get_last_image_info`
      } else {
        statusText += `\n\nNote: No edited image was generated.`
        statusText += `\n\n💡 Tip: Try running the command again - sometimes the first call needs to warm up the model.`
      }

      content.unshift({
        type: 'text',
        text: statusText,
      })

      return { content }
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to edit image: ${
          error instanceof Error
            ? error.message
            : String(error)
        }`
      )
    }
  }

  private async getConfigurationStatus(): Promise<CallToolResult> {
    const isConfigured =
      this.config !== null && this.genAI !== null

    let statusText: string
    let sourceInfo = ''

    if (isConfigured) {
      statusText =
        '✅ Gemini API token is configured and ready to use'

      switch (this.configSource) {
        case 'environment':
          sourceInfo =
            '\n📍 Source: Environment variable (GEMINI_API_KEY)\n💡 This is the most secure configuration method.'
          break
        case 'config_file':
          sourceInfo =
            '\n📍 Source: Local configuration file (.nano-banana-config.json)\n💡 Consider using environment variables for better security.'
          break
      }

      // Add workplace path info
      const workplaceDir = this.config?.workplacePath || process.cwd()
      sourceInfo += `\n\n📁 Images will be saved to: ${workplaceDir}`
      if (this.config?.workplacePath) {
        sourceInfo += ' (custom workplace path)'
      } else {
        sourceInfo += ' (current working directory)'
      }
      sourceInfo +=
        '\n💡 Configure workplace_path via environment variable WORKPLACE_PATH.'
    } else {
      statusText = '❌ Gemini API token is not configured'
      sourceInfo = `

📝 Configuration options:
1. 🥇 Environment variables (Recommended)
   - GEMINI_API_KEY: Your API key (required)
   - WORKPLACE_PATH: Custom workplace directory (optional)
2. 🥈 Use configure_gemini_token tool

💡 For the most secure setup, add this to your MCP configuration:
"env": {
  "GEMINI_API_KEY": "your-api-key-here",
  "WORKPLACE_PATH": "/path/to/your/workplace"
}`
    }

    return {
      content: [
        {
          type: 'text',
          text: statusText + sourceInfo,
        },
      ],
    }
  }


  private async getLastImageInfo(): Promise<CallToolResult> {
    if (!this.lastImagePath) {
      return {
        content: [
          {
            type: 'text',
            text: '📷 No previous image found.\n\nPlease generate or edit an image first, then this command will show information about your last image.',
          },
        ],
      }
    }

    // 检查文件是否存在
    try {
      await fs.access(this.lastImagePath)
      const stats = await fs.stat(this.lastImagePath)

      return {
        content: [
          {
            type: 'text',
            text: `📷 Last Image Information:\n\nPath: ${
              this.lastImagePath
            }\nFile Size: ${Math.round(
              stats.size / 1024
            )} KB\nLast Modified: ${stats.mtime.toLocaleString()}\n\n💡 Use continue_editing to make further changes to this image.`,
          },
        ],
      }
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: `📷 Last Image Information:\n\nPath: ${this.lastImagePath}\nStatus: ❌ File not found\n\n💡 The image file may have been moved or deleted. Please generate a new image.`,
          },
        ],
      }
    }
  }

  private ensureConfigured(): boolean {
    return this.config !== null && this.genAI !== null
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    switch (ext) {
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg'
      case '.png':
        return 'image/png'
      case '.webp':
        return 'image/webp'
      default:
        return 'image/jpeg'
    }
  }



  private async loadConfig(): Promise<void> {
    // Try to load from environment variable first
    const envApiKey = process.env.GEMINI_API_KEY
    const envWorkplacePath = process.env.WORKPLACE_PATH

    if (envApiKey) {
      try {
        this.config = ConfigSchema.parse({
          geminiApiKey: envApiKey,
          workplacePath: envWorkplacePath,
        })
        this.genAI = new GoogleGenAI({
          apiKey: this.config.geminiApiKey,
        })
        this.configSource = 'environment'
        return
      } catch (error) {
        // Invalid API key in environment
      }
    }

    this.configSource = 'not_configured'
  }

  public async run(): Promise<void> {
    await this.loadConfig()

    const transport = new StdioServerTransport()
    await this.server.connect(transport)
  }
}

const server = new NanoBananaMCP()
server.run().catch(console.error)
