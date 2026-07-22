using System;
using System.Collections.Generic;
using System.IO;
using EchoesOfAnotherWorld.Runtime.Actors;
using EchoesOfAnotherWorld.Runtime.Echoes;
using EchoesOfAnotherWorld.Runtime.Wanted;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Save
{
    public sealed class JsonSaveSystem : MonoBehaviour
    {
        private const float SaveInterval = 2f;

        private readonly Dictionary<string, EchoMark> echoCatalog = new Dictionary<string, EchoMark>();
        private Transform player;
        private ActorHealth playerHealth;
        private EchoContainer echoContainer;
        private WantedSystem wantedSystem;
        private float nextSaveTime;
        private string lastSnapshot = string.Empty;

        public string SavePath => Path.Combine(Application.persistentDataPath, "p1-save.json");

        public void Configure(
            Transform playerTransform,
            ActorHealth health,
            EchoContainer container,
            WantedSystem wanted,
            IEnumerable<EchoMark> availableEchoes)
        {
            player = playerTransform;
            playerHealth = health;
            echoContainer = container;
            wantedSystem = wanted;
            echoCatalog.Clear();
            foreach (EchoMark echo in availableEchoes)
            {
                echoCatalog[echo.Id] = echo;
            }

            Load();
            lastSnapshot = File.Exists(SavePath) ? JsonUtility.ToJson(Capture(), true) : string.Empty;
            nextSaveTime = Time.unscaledTime + SaveInterval;
        }

        private void Update()
        {
            if (player == null || Time.unscaledTime < nextSaveTime)
            {
                return;
            }

            nextSaveTime = Time.unscaledTime + SaveInterval;
            SaveIfChanged();
        }

        private void OnApplicationPause(bool paused)
        {
            if (paused)
            {
                SaveIfChanged();
            }
        }

        private void OnApplicationQuit()
        {
            SaveIfChanged();
        }

        public void SaveIfChanged()
        {
            if (player == null)
            {
                return;
            }

            // 仅当存档片段发生变化时落盘，避免每帧重写 JSON。
            string snapshot = JsonUtility.ToJson(Capture(), true);
            if (snapshot == lastSnapshot)
            {
                return;
            }

            try
            {
                string directory = Path.GetDirectoryName(SavePath);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }

                string temporaryPath = SavePath + ".tmp";
                File.WriteAllText(temporaryPath, snapshot);
                if (File.Exists(SavePath))
                {
                    File.Delete(SavePath);
                }

                File.Move(temporaryPath, SavePath);
                lastSnapshot = snapshot;
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"保存失败：{exception.Message}");
            }
        }

        private SaveData Capture()
        {
            return new SaveData
            {
                playerX = player.position.x,
                playerY = player.position.y,
                playerHealth = playerHealth.CurrentHealth,
                equippedEchoIds = echoContainer.GetEquippedIds(),
                selectedEchoSlot = echoContainer.SelectedSlot,
                wantedLevel = wantedSystem.Level
            };
        }

        private void Load()
        {
            if (!File.Exists(SavePath))
            {
                return;
            }

            try
            {
                SaveData data = JsonUtility.FromJson<SaveData>(File.ReadAllText(SavePath));
                if (data == null || data.version != 1)
                {
                    return;
                }

                player.position = new Vector3(data.playerX, data.playerY, player.position.z);
                playerHealth.SetCurrentHealth(data.playerHealth);
                wantedSystem.SetLevel(data.wantedLevel);
                int savedSlots = data.equippedEchoIds == null ? 0 : data.equippedEchoIds.Length;
                for (int index = 0; index < EchoContainer.MaximumSlots; index++)
                {
                    EchoMark echo = null;
                    if (index < savedSlots)
                    {
                        string id = data.equippedEchoIds[index];
                        if (!string.IsNullOrEmpty(id))
                        {
                            echoCatalog.TryGetValue(id, out echo);
                        }
                    }

                    echoContainer.Equip(index, echo);
                }

                echoContainer.SelectSlot(data.selectedEchoSlot);
            }
            catch (Exception exception)
            {
                Debug.LogWarning($"读取存档失败，将使用新游戏状态：{exception.Message}");
            }
        }
    }
}
