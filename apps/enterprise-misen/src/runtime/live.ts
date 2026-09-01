import { Agent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { prepareAgentCustomization } from './customized.js'
/** Live route: key resolution is confined to Pi's getApiKey provider boundary. */
export async function liveAgent(root:string) { const models=createModels(); models.setProvider(openaiProvider()); const model=models.getModel('openai','gpt-5.6-luna'); if(!model) throw new Error('gpt-5.6-luna unavailable from official Pi OpenAI catalog'); const streamFn=(activeModel:any,context:any,options:any)=>models.streamSimple(activeModel,context,{...options,maxRetries:0} as any); const customization=await prepareAgentCustomization(root); return new Agent({initialState:{systemPrompt:customization.systemPrompt,model,thinkingLevel:'medium',tools:[...customization.tools]}, streamFn, getApiKey: provider => provider === 'openai' ? process.env.OPENAI_API_KEY : undefined, toolExecution:'sequential', maxRetryDelayMs:0,beforeToolCall:customization.hooks.beforeToolCall,afterToolCall:customization.hooks.afterToolCall}) }
