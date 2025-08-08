require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();

app.use(express.json());
app.use(express.text());
app.use(express.raw());

// Proxy Ollama's /api/chat to OpenRouter's /v1/chat/completions
app.post('/api/chat', async (req, res) => {
  console.log('Request headers:', req.headers);
  console.log('Request body type:', typeof req.body);
  console.log('Request body:', req.body);
  console.log('Received /api/chat request:', JSON.stringify(req.body, null, 2));
  
  // Try to parse body if it's a string
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
      console.log('Parsed body from string:', JSON.stringify(req.body, null, 2));
    } catch (e) {
      console.error('Failed to parse body as JSON:', e.message);
    }
  }
  
  try {
    // Validate incoming request
    if (!req.body || !req.body.model) {
      throw new Error('Missing required field: model');
    }
    
    // Handle both Ollama's 'prompt' format and OpenRouter's 'messages' format
    let messages;
    if (req.body.prompt) {
      // Convert Ollama's prompt format to messages format
      messages = [
        {
          role: 'user',
          content: req.body.prompt
        }
      ];
    } else if (req.body.messages && Array.isArray(req.body.messages) && req.body.messages.length > 0) {
      // Use existing messages format
      messages = req.body.messages;
    } else {
      throw new Error('Missing required field: prompt or messages');
    }

    const openRouterRequest = {
      model: req.body.model.replace(':latest', ''),
      messages: messages,
      stream: req.body.stream || false
    };

    if (openRouterRequest.stream) {
      // Handle streaming response
      const streamResponse = await axios({
        method: 'post',
        url: 'https://openrouter.ai/api/v1/chat/completions',
        data: openRouterRequest,
        headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` },
        responseType: 'stream' // Enable streaming
      });

      let fullContent = '';
      streamResponse.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(line => line.trim());
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                fullContent += parsed.choices[0].delta.content;
              }
            } catch (e) {
              console.error('Error parsing stream chunk:', e.message);
            }
          }
        }
      });

      streamResponse.data.on('end', () => {
        const ollamaResponse = {
          model: req.body.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: fullContent || 'No content returned'
          },
          done: true
        };
        console.log('Sending /api/chat response (streamed):', JSON.stringify(ollamaResponse, null, 2));
        res.json(ollamaResponse);
      });

      streamResponse.data.on('error', (error) => {
        throw error;
      });
    } else {
      // Handle non-streaming response
      const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', openRouterRequest, {
        headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
      });

      console.log('Raw OpenRouter response:', JSON.stringify(response.data, null, 2));

      if (!response.data.choices || !Array.isArray(response.data.choices) || response.data.choices.length === 0) {
        throw new Error('No valid choices in OpenRouter response');
      }

      const ollamaResponse = {
        model: req.body.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: response.data.choices[0].message.content || 'No content returned'
        },
        done: true
      };

      console.log('Sending /api/chat response:', JSON.stringify(ollamaResponse, null, 2));
      res.json(ollamaResponse);
    }
  } catch (error) {
    console.error('Error in /api/chat:', error.message);
    
    // Safely extract error response data to avoid circular references
    let errorResponseData = null;
    if (error.response && error.response.data) {
      try {
        errorResponseData = JSON.stringify(error.response.data, null, 2);
        console.error('OpenRouter error response:', errorResponseData);
      } catch (stringifyError) {
        console.error('OpenRouter error response (could not stringify):', error.response.status, error.response.statusText);
      }
    }
    
    const ollamaErrorResponse = {
      model: req.body.model || 'unknown',
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: `Error: ${error.message}${errorResponseData ? ' - ' + errorResponseData : ''}`
      },
      done: true
    };
    console.log('Sending /api/chat error response:', JSON.stringify(ollamaErrorResponse, null, 2));
    res.status(200).json(ollamaErrorResponse);
  }
});

// Proxy OpenAI-compatible /v1/chat/completions to OpenRouter
app.post('/v1/chat/completions', async (req, res) => {
  console.log('Received /v1/chat/completions request:', JSON.stringify(req.body, null, 2));
  try {
    const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', req.body, {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
    });
    console.log('Response from OpenRouter:', JSON.stringify(response.data, null, 2));
    res.json(response.data);
  } catch (error) {
    console.error('Error in /v1/chat/completions:', error.message);
    if (error.response && error.response.data) {
      try {
        console.error('OpenRouter response:', JSON.stringify(error.response.data, null, 2));
      } catch (stringifyError) {
        console.error('OpenRouter response (could not stringify):', error.response.status, error.response.statusText);
      }
    }
    res.status(500).send(error.message);
  }
});

// Emulate Ollama's /api/tags by fetching models from OpenRouter
app.get('/api/tags', async (req, res) => {
  console.log('Received /api/tags request');
  try {
    const response = await axios.get('https://openrouter.ai/api/v1/models', {
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}` }
    });
    console.log('Raw response from OpenRouter /api/v1/models:', JSON.stringify(response.data, null, 2));

    const openRouterModels = {
      models: response.data.data.map(model => ({
        model: `${model.id}:latest`,
        name: model.name || model.id,
        modified_at: '2025-02-27T00:00:00Z',
        size: 0,
        digest: crypto.createHash('sha256').update(model.id).digest('hex')
      }))
    };

    console.log('Sending /api/tags response:', JSON.stringify(openRouterModels, null, 2));
    res.json(openRouterModels);
  } catch (error) {
    console.error('Error fetching models from OpenRouter:', error.message);
    if (error.response && error.response.data) {
      try {
        console.error('OpenRouter response:', JSON.stringify(error.response.data, null, 2));
      } catch (stringifyError) {
        console.error('OpenRouter response (could not stringify):', error.response.status, error.response.statusText);
      }
    }
    res.status(500).send('Failed to fetch models from OpenRouter');
  }
});

// Basic health check
app.get('/', (req, res) => {
  console.log('Received root endpoint request');
  res.send('Proxy is running');
});

app.listen(11434, () => console.log('Proxy running on port 11434'));