Смотри, у меня есть проект для живых выступлений. Он построен на актуальной версии JUCE. Фронтенд на Vite (дев сервер запущен). Как будешь что-то менять запускай pnpm run rebuild:run и в целом проверяй тесты как какую-то фичу заканчиваешь. Если чёто меняется ток на фронте то перезапускать прилу не надо.

Я хочу улучшить роутинг со стороны JUCE. Щас он то работает но периодически всплывают Issues как щас: на мастере не работает Mute, моно-стерео (переключалка), баланс и громкость.

Я заметил, что в целом в приле оч много костылей в плане роутинга. Поэтому я думаю что стоит вынести его в отдельную часть движка и написать всё там оч понятным но технически идеально архитектурным способом.

Я хочу полностью поменять типы (в том числе в проектах и сделать автомиграцию на новый стандарт при сейве и так чтобы эту миграцию легко было выпилить - там щас ещё миграции есть и вот чтоб их тоже ибо я ещё прилу в паблик бету не запустил и поэтому щас лишние миграции не к чему). Я тебе чуть позже опишу конкретно за роутинг и сущности. Щас я тебе опишу прежде всего по структуре проекта как это лучше всего сделать

Вот старый формат:
{
  "formatVersion": 1,
  "name": "first",
  "sampleRate": 48000,
  "builtInClickEnabled": true,
  "builtInClickName": "Click",
  "builtInClickBusId": "",
  "builtInClickGainDb": 0,
  "builtInClickPan": 0,
  "builtInClickMono": false,
  "builtInClickSolo": false,
  "builtInClickSends": [
    {
      "bus": "bus_1",
      "gainDb": 6,
      "preFader": false,
      "enabled": true
    },
    {
      "bus": "bus_2",
      "gainDb": 6,
      "preFader": false,
      "enabled": true
    },
    {
      "bus": "bus_3",
      "gainDb": 6,
      "preFader": false,
      "enabled": true
    },
    {
      "bus": "bus_4",
      "gainDb": 6,
      "preFader": false,
      "enabled": true
    }
  ],
  "busses": [
    {
      "id": "main",
      "name": "Main",
      "channels": 2,
      "output": {
        "startChannel": 0
      },
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "isAux": false
    },
    {
      "id": "bus_1",
      "name": "Send 1",
      "channels": 1,
      "output": {
        "startChannel": 10
      },
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "isAux": true
    },
    {
      "id": "bus_2",
      "name": "Send 2",
      "channels": 1,
      "output": {
        "startChannel": 11
      },
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "isAux": true
    },
    {
      "id": "bus_3",
      "name": "Send 3",
      "channels": 2,
      "output": {
        "startChannel": 12
      },
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "isAux": true
    },
    {
      "id": "bus_4",
      "name": "Send 4",
      "channels": 2,
      "output": {
        "startChannel": 0
      },
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "isAux": true
    }
  ],
  "tracks": [
    {
      "id": "trk_1",
      "name": "Drums",
      "bus": "direct:3,direct:4",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_3",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_2",
      "name": "Percussion",
      "bus": "direct:3,direct:4",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_3",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_3",
      "name": "Loops",
      "bus": "direct:3,direct:4",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_3",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_4",
      "name": "Bass",
      "bus": "direct:5,direct:6",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_3",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_5",
      "name": "Guitars",
      "bus": "direct:7,direct:8",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_3",
          "gainDb": -60,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_6",
      "name": "Synths",
      "bus": "direct:7,direct:8",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_7",
      "name": "Keys",
      "bus": "direct:7,direct:8",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_8",
      "name": "Vocals",
      "bus": "direct:7,direct:8",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_9",
      "name": "Backing Vocals",
      "bus": "direct:7,direct:8",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_10",
      "name": "SFX",
      "bus": "direct:7,direct:8",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    },
    {
      "id": "trk_11",
      "name": "Guide",
      "bus": "direct:7,direct:8",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "mono": false,
      "sends": [
        {
          "bus": "bus_1",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_2",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        },
        {
          "bus": "bus_4",
          "gainDb": 6,
          "preFader": false,
          "enabled": true
        }
      ]
    }
  ],
  "lighting": {
    "enabled": true,
    "kind": "resoLight",
    "resoLightColumns": 2,
    "resoLightRows": 1,
    "idleBehavior": "staticColor",
    "idleColorR": 255,
    "idleColorG": 255,
    "idleColorB": 255,
    "idleIntensity": 1,
    "idleEffectType": "none",
    "idleEffectRateHz": 2,
    "idleGradientPreset": "solid",
    "idleGradientColors": "",
    "defaultRefreshRateHz": 44,
    "artNetTargetHost": "",
    "fixtures": [
      {
        "id": "bar_1",
        "name": "Bar 1",
        "kind": "resoLightBar",
        "gridColumn": 0,
        "gridRow": 0,
        "ledCount": 120,
        "addressable": true,
        "posX": 0,
        "posY": 0,
        "posZ": 0,
        "rotationYDeg": 0,
        "mountedHorizontally": false,
        "dmxUniverse": 0,
        "dmxStartChannel": 1,
        "dmxChannelCount": 3,
        "shape": "bar",
        "matrixCols": 0,
        "channelProfile": "rgb",
        "tiltDeg": 0,
        "refreshRateHz": 0,
        "networkHost": ""
      },
      {
        "id": "bar_2",
        "name": "Bar 2",
        "kind": "resoLightBar",
        "gridColumn": 1,
        "gridRow": 0,
        "ledCount": 120,
        "addressable": true,
        "posX": 2,
        "posY": 0,
        "posZ": 0,
        "rotationYDeg": 0,
        "mountedHorizontally": false,
        "dmxUniverse": 0,
        "dmxStartChannel": 1,
        "dmxChannelCount": 3,
        "shape": "bar",
        "matrixCols": 0,
        "channelProfile": "rgb",
        "tiltDeg": 0,
        "refreshRateHz": 0,
        "networkHost": ""
      }
    ]
  },
  "lightTracks": [
    {
      "id": "lt_1",
      "name": "Both",
      "fixtureIds": [
        "bar_1",
        "bar_2"
      ]
    },
    {
      "id": "lt_2",
      "name": "Left",
      "fixtureIds": [
        "bar_1"
      ]
    },
    {
      "id": "lt_3",
      "name": "Right  ",
      "fixtureIds": [
        "bar_2"
      ]
    }
  ],
  "songs": [
    {
      "id": "song_1",
      "name": "NEVERLAND",
      "bpm": 120,
      "timeSignature": {
        "numerator": 4,
        "denominator": 4
      },
      "playbackMode": "autoplayNext",
      "regions": [
        {
          "id": "reg_song_1_trk_4",
          "trackId": "trk_4",
          "file": "Audio/516418366720-NVRLND_BASS_120BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 166,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_1_trk_9",
          "trackId": "trk_9",
          "file": "Audio/516418369280-NVRLND_VOX_BK_120BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 166,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_1_trk_6",
          "trackId": "trk_6",
          "file": "Audio/516418366720-NVRLND_SYNTHS_120BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 226.411917,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_1_trk_10",
          "trackId": "trk_10",
          "file": "Audio/516418362880-NVRLND_SFX_120BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 117.173021,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_1_trk_2",
          "trackId": "trk_2",
          "file": "Audio/516418369280-NVRLND_PERC_120BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 166,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_1_trk_1",
          "trackId": "trk_1",
          "file": "Audio/516418362880-NVRLND_DRUMS_120BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 166,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        }
      ],
      "events": [],
      "sections": [
        {
          "id": "sec_1",
          "name": "Intro",
          "startSeconds": 0,
          "colorIndex": 0
        },
        {
          "id": "sec_2",
          "name": "Verse",
          "startSeconds": 8,
          "colorIndex": 1
        },
        {
          "id": "sec_3",
          "name": "Chorus",
          "startSeconds": 34,
          "colorIndex": 2
        },
        {
          "id": "sec_4",
          "name": "Verse",
          "startSeconds": 66,
          "colorIndex": 3
        },
        {
          "id": "sec_5",
          "name": "Chorus",
          "startSeconds": 98,
          "colorIndex": 4
        },
        {
          "id": "sec_6",
          "name": "Solo",
          "startSeconds": 130,
          "colorIndex": 5
        }
      ],
      "lightCues": [
        {
          "id": "lc_1",
          "trackId": "lt_1",
          "startSeconds": 0,
          "durationSeconds": 8,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 9.1,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "fire",
          "effectSourceType": "track",
          "effectSourceId": "trk_6",
          "effectIntensity": 0.800000011920929,
          "tempoSync": true,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "cyberpunkFire",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_2",
          "trackId": "lt_2",
          "startSeconds": 8,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_3",
          "trackId": "lt_3",
          "startSeconds": 8.5,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_4",
          "trackId": "lt_2",
          "startSeconds": 9.25,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_5",
          "trackId": "lt_3",
          "startSeconds": 9.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_6",
          "trackId": "lt_2",
          "startSeconds": 10,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_7",
          "trackId": "lt_3",
          "startSeconds": 10.5,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_8",
          "trackId": "lt_2",
          "startSeconds": 11.25,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_9",
          "trackId": "lt_3",
          "startSeconds": 11.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_10",
          "trackId": "lt_1",
          "startSeconds": 9.75,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 0,
          "colorB": 0,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_11",
          "trackId": "lt_1",
          "startSeconds": 11.75,
          "durationSeconds": 0.25,
          "colorR": 110,
          "colorG": 0,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_12",
          "trackId": "lt_1",
          "startSeconds": 13.75,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 0,
          "colorB": 0,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_13",
          "trackId": "lt_1",
          "startSeconds": 15.75,
          "durationSeconds": 0.25,
          "colorR": 110,
          "colorG": 0,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "pulse",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": true,
          "tempoSubdiv": "1/8",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_14",
          "trackId": "lt_2",
          "startSeconds": 12,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_15",
          "trackId": "lt_2",
          "startSeconds": 13.25,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_16",
          "trackId": "lt_2",
          "startSeconds": 14,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_17",
          "trackId": "lt_2",
          "startSeconds": 15.25,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 0,
          "colorB": 0,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_18",
          "trackId": "lt_3",
          "startSeconds": 12.5,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_19",
          "trackId": "lt_3",
          "startSeconds": 13.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_20",
          "trackId": "lt_3",
          "startSeconds": 14.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_21",
          "trackId": "lt_3",
          "startSeconds": 15.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 0,
          "colorB": 0,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_22",
          "trackId": "lt_1",
          "startSeconds": 17.75,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 0,
          "colorB": 0,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_23",
          "trackId": "lt_1",
          "startSeconds": 19.75,
          "durationSeconds": 0.25,
          "colorR": 110,
          "colorG": 0,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_24",
          "trackId": "lt_2",
          "startSeconds": 16,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_25",
          "trackId": "lt_2",
          "startSeconds": 17.25,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_26",
          "trackId": "lt_2",
          "startSeconds": 18,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_27",
          "trackId": "lt_2",
          "startSeconds": 19.25,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_28",
          "trackId": "lt_3",
          "startSeconds": 16.5,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_29",
          "trackId": "lt_3",
          "startSeconds": 17.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_30",
          "trackId": "lt_3",
          "startSeconds": 18.5,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_31",
          "trackId": "lt_3",
          "startSeconds": 19.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_32",
          "trackId": "lt_1",
          "startSeconds": 21.75,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 0,
          "colorB": 0,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_33",
          "trackId": "lt_1",
          "startSeconds": 23.75,
          "durationSeconds": 0.25,
          "colorR": 110,
          "colorG": 0,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "pulse",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": true,
          "tempoSubdiv": "1/8",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_34",
          "trackId": "lt_2",
          "startSeconds": 20,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_35",
          "trackId": "lt_2",
          "startSeconds": 21.25,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_36",
          "trackId": "lt_2",
          "startSeconds": 22,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_37",
          "trackId": "lt_2",
          "startSeconds": 23.25,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_38",
          "trackId": "lt_3",
          "startSeconds": 20.5,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_39",
          "trackId": "lt_3",
          "startSeconds": 21.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_40",
          "trackId": "lt_3",
          "startSeconds": 22.5,
          "durationSeconds": 0.5,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_41",
          "trackId": "lt_3",
          "startSeconds": 23.5,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        },
        {
          "id": "lc_42",
          "trackId": "lt_1",
          "startSeconds": 14.75,
          "durationSeconds": 0.25,
          "colorR": 255,
          "colorG": 255,
          "colorB": 255,
          "intensity": 1,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "label": "",
          "effectType": "",
          "effectSourceType": "bus",
          "effectSourceId": "",
          "effectIntensity": 0.800000011920929,
          "tempoSync": false,
          "tempoSubdiv": "1/4",
          "effectRateHz": 2,
          "gradientPreset": "solid",
          "gradientColors": "",
          "blendMode": "normal"
        }
      ]
    },
    {
      "id": "song_2",
      "name": "RUN",
      "bpm": 140,
      "timeSignature": {
        "numerator": 4,
        "denominator": 4
      },
      "playbackMode": "autoplayNext",
      "regions": [
        {
          "id": "reg_song_2_trk_3",
          "trackId": "trk_3",
          "file": "Audio/516418362880-RUN_LOOPS_140BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 267.428562,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_2_trk_6",
          "trackId": "trk_6",
          "file": "Audio/516418369280-RUN_SYNTHS_140BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 267.428562,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_2_trk_4",
          "trackId": "trk_4",
          "file": "Audio/516418366720-RUN_BASS_140BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 267.428562,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_2_trk_9",
          "trackId": "trk_9",
          "file": "Audio/516418362880-RUN_BACKVOX_140BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 267.428562,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        },
        {
          "id": "reg_song_2_trk_10",
          "trackId": "trk_10",
          "file": "Audio/516418369280-RUN_SFX_140BPM.wav",
          "startSeconds": 0,
          "sourceOffsetSeconds": 0,
          "durationSeconds": 267.428562,
          "gainDb": 0,
          "fadeInSeconds": 0,
          "fadeOutSeconds": 0,
          "fadeInCurve": 0,
          "fadeOutCurve": 0,
          "loop": false
        }
      ],
      "events": [],
      "sections": [],
      "lightCues": []
    }
  ],
  "cycle": {
    "active": false,
    "skip": false,
    "leftSec": 16,
    "rightSec": 32,
    "songIndex": 0
  },
  "keybindings": {
    "mode_editor": "f3",
    "mode_mixer": "f2",
    "mode_player": "f1",
    "mode_settings": "f4",
    "next": "n",
    "play": "space",
    "prev": "p",
    "redo": "cmd + shift + z",
    "section_last": "end",
    "section_next": "]",
    "section_prev": "[",
    "stop": "escape",
    "undo": "cmd + z"
  },
  "midiMappings": []
}


А вот как я думаю должно быть в новом (не сломай ток миди и прочее что я не менял. кейбиндингс можешь вырезать ибо они щас менеджатся на уровне настроек прилы - сразу скажу, я менял и свет и вообще все типы. например вместо харкодных айдишников для регионов я писал UUID, тоже самое наверное и для CUE надо и вот что я вместо пустых кавычек null ставил везде и в целом группировал красиво. Надо реально красоту навести в формате а не как щас. Я тебе всё сохранил в файлы before.json и after.json в корне проекта мол как было и как надо):

Я попросил ИИшку сгенерировать типы. Хз правильно ли она всё сделала:
/**
 * ============================================================================
 * AUDIO OUTPUT & ROUTING TYPES
 * ============================================================================
 */

export type AudioOutputBusId = `audio::send:${number}`;
export type AudioTrackId = `audio::track:${number}`;
export type AudioOutChannelId = `audio::out:${number}`;

/**
 * Валидация выходов:
 * - Моно: "audio::out:1"
 * - Стереопара: "audio::out:1,audio::out:2"
 */
export type MonoExtOutTarget = AudioOutChannelId;
export type StereoExtOutTarget = `${AudioOutChannelId},${AudioOutChannelId}`;
export type ExtOutTarget = MonoExtOutTarget | StereoExtOutTarget;

/**
 * Посыл на Send-шину (Bus)
 */
export interface SendConfig<TBusId extends string = AudioOutputBusId> {
  /** ID целевой Send-шины (например, "audio::send:1") */
  bus: TBusId;
  /** Уровень посыла в процентах (0–100) */
  level: number;
  /** Pre-fader / Post-fader роутинг */
  preFader: boolean;
  /** Активен ли посыл */
  enabled: boolean;
}

/**
 * Discriminated Union для конфигурации выхода (Output)
 */
export type TrackOutput<
  TBusId extends string = AudioOutputBusId,
  TTrackId extends string = AudioTrackId
> =
  | {
      type: 'main';
      target: 'audio::main';
      sends?: SendConfig<TBusId>[];
    }
  | {
      type: 'sends-only';
      target: null;
      sends: SendConfig<TBusId>[];
    }
  | {
      type: 'ext-out';
      /** Физические каналы выхода (напр. "audio::out:11" или "audio::out:3,audio::out:4") */
      target: ExtOutTarget;
      sends?: SendConfig<TBusId>[];
    }
  | {
      type: 'send';
      /** ID дорожки или шины, на которую направляется сигнал */
      target: TTrackId | TBusId;
      sends?: SendConfig<TBusId>[];
    };

/**
 * Общие свойства аудио-дорожки/канала
 */
export interface BaseAudioChannel {
  enabled?: boolean;
  name: string;
  channels: 1 | 2;
  gainDb: number;
  pan: number; // -1 .. 1
  mute: boolean;
  solo: boolean;
  output: TrackOutput;
}

export interface AudioTrack extends BaseAudioChannel {
  id: AudioTrackId;
}

export interface SendBusTrack extends BaseAudioChannel {
  id: AudioOutputBusId;
}

export interface MasterTrack extends BaseAudioChannel {
  id?: 'audio::main';
}

export interface ClickTrack extends BaseAudioChannel {
  output: Extract<TrackOutput, { type: 'sends-only' | 'ext-out' }>;
}


/**
 * ============================================================================
 * MIDI MAPPINGS & CONTROLS
 * ============================================================================
 */

export type MidiMessageType = 'note' | 'cc' | 'pitchbend' | 'programChange';

export interface MidiSource {
  /** MIDI-канал (1-16) */
  channel: number;
  /** Номер CC или Note number (0-127) */
  number: number;
  /** Тип сообщения */
  type: MidiMessageType;
}

export interface MidiTarget {
  /** Категория управляемого параметра */
  domain: 'audio' | 'lighting' | 'transport' | 'song';
  /** ID объекта (например, "audio::track:1" или "light::cue:5") */
  entityId: string;
  /** Имя параметра ("gainDb", "mute", "intensity", "play") */
  property: string;
}

export interface MidiMapping {
  id: string;
  name?: string;
  enabled: boolean;
  source: MidiSource;
  target: MidiTarget;
  /** Мин/макс границы изменения параметра при 0-127 MIDI value */
  range?: {
    min: number;
    max: number;
  };
}

export interface MidiConfig {
  mappings: MidiMapping[];
}


/**
 * ============================================================================
 * LIGHTING (RESOLIGHT & ART-NET)
 * ============================================================================
 */

export type LightTrackId = `light::track:${number}`;
export type LightFixtureId = `light::bar:${number}` | `light::fixture:${number}`;

export type ResolightKind = 'resolight' | `resolight::${string}`;

export interface RgbColor {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
}

export interface LightEffect {
  type: 'fire' | 'pulse' | 'strobe' | 'rainbow' | 'none' | null;
  sourceType: 'track' | 'bus' | 'master' | null;
  sourceId: string | null;
  intensity: number; // 0..1
  tempoSync: boolean;
  tempoSubdivision: '1/4' | '1/8' | '1/16' | '1/32' | string;
  rateHz: number;
}

export interface LightGradient {
  preset: 'solid' | 'cyberpunkFire' | string;
  colors: RgbColor[] | null;
}

export interface LightFixture {
  id: LightFixtureId;
  name: string;
  /** Неймспейс оборудования (например, "resolight::bar") */
  kind: ResolightKind;
  grid: {
    column: number;
    row: number;
  };
  ledCount: number;
  addressable: boolean;
  position: { x: number; y: number; z: number };
  rotation: { y: number };
  mountedHorizontally: boolean;
  dmx: {
    universe: number;
    startChannel: number;
    channelCount: number;
  };
  shape: 'bar' | 'matrix' | 'single' | string;
  matrixColumns: number;
  channelProfile: 'rgb' | 'rgbw' | string;
  tiltDegrees: number;
  refreshRateHz: number;
  networkHost: string | null;
}

export interface LightTrack {
  id: LightTrackId;
  name: string;
  fixtureIds: LightFixtureId[];
}

export interface LightCue {
  id: `light::cue:${number}`;
  trackId: LightTrackId;
  startSeconds: number;
  durationSeconds: number;
  label: string | null;
  color: RgbColor;
  intensity: number; // 0..1
  fade: {
    inSeconds: number;
    outSeconds: number;
  };
  effect: LightEffect;
  gradient: LightGradient;
  blendMode: 'normal' | 'add' | 'multiply' | string;
}

export interface LightingConfig {
  enabled: boolean;
  kind: 'resolight' | string;
  resolight: {
    columns: number;
    rows: number;
  };
  idle: {
    behavior: 'static' | string;
    color: RgbColor;
    intensity: number;
    effect: LightEffect;
    gradient: LightGradient;
  };
  defaultRefreshRateHz: number;
  artNetTargetHost: string | null;
  fixtures: LightFixture[];
  tracks: LightTrack[];
}


/**
 * ============================================================================
 * SONGS, TIMELINE & PROJECT ROOT
 * ============================================================================
 */

export interface RegionSource {
  file: string;
  offsetSeconds: number;
}

export interface RegionFade {
  inSeconds: number;
  outSeconds: number;
  inCurve: number;
  outCurve: number;
}

export interface RegionLoop {
  enabled: boolean;
  lengthSeconds: number;
}

export interface AudioRegion {
  id: string; // UUID
  trackId: AudioTrackId;
  startSeconds: number;
  durationSeconds: number;
  gainDb: number;
  source: RegionSource;
  fade: RegionFade;
  loop: RegionLoop;
}

export interface SongSection {
  id: `meta::section:${number}`;
  name: string;
  startSeconds: number;
  colorIndex: number;
}

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface Song {
  id: `meta::song:${number}`;
  name: string;
  bpm: number;
  timeSignature: TimeSignature;
  /** Поведение по завершении песни */
  onEnded?: 'next' | 'stop' | string;
  playbackMode?: 'autoplayNext' | 'pause' | string;
  regions: AudioRegion[];
  events: unknown[];
  sections: SongSection[];
  lightCues: LightCue[];
}

export interface CycleConfig {
  active: boolean;
  skip: boolean;
  startSeconds: number;
  endSeconds: number;
  songIndex: number;
}

export interface ProjectFormat {
  version: number;
}

/**
 * Корневая структура проекта
 */
export interface ShowProject {
  format: ProjectFormat;
  name: string;
  sampleRate: number;
  click: ClickTrack;
  main: MasterTrack;
  sends: SendBusTrack[];
  tracks: AudioTrack[];
  lighting: LightingConfig;
  songs: Song[];
  cycle: CycleConfig;
  midi: MidiConfig;
}

----
Вот через автоген (но оно вышло коряво):
export interface Root {
  format: Format
  name: string
  sampleRate: number
  click: Click
  main: Main
  sends: Send2[]
  tracks: Track[]
  lighting: Lighting
  songs: Song[]
  cycle: Cycle
  midi: Midi
}

export interface Format {
  version: number
}

export interface Click {
  enabled: boolean
  name: string
  channels: number
  gainDb: number
  pan: number
  mute: boolean
  solo: boolean
  output: Output
}

export interface Output {
  type: string
  target: any
  sends: Send[]
}

export interface Send {
  bus: string
  level: number
  preFader: boolean
  enabled: boolean
}

export interface Main {
  enabled: boolean
  name: string
  channels: number
  gainDb: number
  pan: number
  mute: boolean
  solo: boolean
  output: Output2
}

export interface Output2 {
  type: string
  target: string
}

export interface Send2 {
  id: string
  name: string
  channels: number
  gainDb: number
  pan: number
  mute: boolean
  solo: boolean
  output: Output3
}

export interface Output3 {
  type: string
  target: string
}

export interface Track {
  id: string
  name: string
  channels: number
  gainDb: number
  pan: number
  mute: boolean
  solo: boolean
  output: Output4
}

export interface Output4 {
  type: string
  target: string
  sends: Send3[]
}

export interface Send3 {
  bus: string
  level: number
  preFader: boolean
  enabled: boolean
}

export interface Lighting {
  enabled: boolean
  kind: string
  resolight: Resolight
  idle: Idle
  defaultRefreshRateHz: number
  artNetTargetHost: any
  fixtures: Fixture[]
  tracks: Track2[]
}

export interface Resolight {
  columns: number
  rows: number
}

export interface Idle {
  behavior: string
  color: Color
  intensity: number
  effect: Effect
  gradient: Gradient
}

export interface Color {
  r: number
  g: number
  b: number
}

export interface Effect {
  type: string
  rateHz: number
}

export interface Gradient {
  preset: string
  colors: any
}

export interface Fixture {
  id: string
  name: string
  kind: string
  grid: Grid
  ledCount: number
  addressable: boolean
  position: Position
  rotation: Rotation
  mountedHorizontally: boolean
  dmx: Dmx
  shape: string
  matrixColumns: number
  channelProfile: string
  tiltDegrees: number
  refreshRateHz: number
  networkHost: any
}

export interface Grid {
  column: number
  row: number
}

export interface Position {
  x: number
  y: number
  z: number
}

export interface Rotation {
  y: number
}

export interface Dmx {
  universe: number
  startChannel: number
  channelCount: number
}

export interface Track2 {
  id: string
  name: string
  fixtureIds: string[]
}

export interface Song {
  id: string
  name: string
  bpm: number
  timeSignature: TimeSignature
  onEnded?: string
  regions: Region[]
  events: any[]
  sections: Section[]
  lightCues: LightCue[]
  playbackMode?: string
}

export interface TimeSignature {
  numerator: number
  denominator: number
}

export interface Region {
  id: string
  trackId: string
  startSeconds: number
  durationSeconds: number
  gainDb: number
  source: Source
  fade: Fade
  loop: Loop
}

export interface Source {
  file: string
  offsetSeconds: number
}

export interface Fade {
  inSeconds: number
  outSeconds: number
  inCurve: number
  outCurve: number
}

export interface Loop {
  enabled: boolean
  lengthSeconds: number
}

export interface Section {
  id: string
  name: string
  startSeconds: number
  colorIndex: number
}

export interface LightCue {
  id: string
  trackId: string
  startSeconds: number
  durationSeconds: number
  label: any
  color: Color2
  intensity: number
  fade: Fade2
  effect: Effect2
  gradient: Gradient2
  blendMode: string
}

export interface Color2 {
  r: number
  g: number
  b: number
}

export interface Fade2 {
  inSeconds: number
  outSeconds: number
}

export interface Effect2 {
  type?: string
  sourceType: string
  sourceId?: string
  intensity: number
  tempoSync: boolean
  tempoSubdivision: string
  rateHz: number
}

export interface Gradient2 {
  preset: string
  colors: any
}

export interface Cycle {
  active: boolean
  skip: boolean
  startSeconds: number
  endSeconds: number
  songIndex: number
}

export interface Midi {
  mappings: any[]
}


--------
Короче суть в том что все дорожки в микшере (не важно мастер это или сенд или метроном) - всё должно иметь общую логику, даже для metering. Та и даже ауты (которые у нас всегда моно для гибкости - там ток фронт группирует на стерео ну и когда посылаем на два моно канала - например 1 и 2 это левый и правый колонок допустим в деф конфигурации то получается стерео). Потому что щас там оч много костылей. А мне это прям не нравится. И представь когда проект выростет какая фигня это будет геморойная. Поэтому лучше сейчас переписать эти моменты чтоб нам же было проще.

Насчёт соло:
Тут всё должно действовать по логическим группам. Метроном с дорожками проекта имеют общую группу. Сенды имеют свою группу. Мейн пока в своей группе один (поэтому соло для него временно ничего не делает), но учитывай что это временно. Членство в группах должно передаваться на фронт чтобы фронт понимал какие дорожки отображать замьючеными когда какая-то дорожка в режиме соло.

Гейн и пан должны отражаться на audio meter. Входящие сенды подмешанные тоже должны. Единственное что не должно отражаться на метерах это то что происходит с сигналом дальше. Ну типо замьючена ли дорожка или нет. Является ли какая-то другая дорожка в соло или нет. На уровне этой дорожки это не важно. Вот... Как-то так наверное.

Сделаешь? Я очень прошу, отнесись профессионально
