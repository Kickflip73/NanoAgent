using System.Collections.Generic;
using EchoesOfAnotherWorld.Runtime.Echoes;
using EchoesOfAnotherWorld.Runtime.Events;
using EchoesOfAnotherWorld.Runtime.Save;
using EchoesOfAnotherWorld.Runtime.Wanted;
using EchoesOfAnotherWorld.Runtime.World;
using NUnit.Framework;
using UnityEngine;

namespace EchoesOfAnotherWorld.Tests
{
    public sealed class PhaseOneSystemsTests
    {
        [Test]
        public void WantedSystem_ReportsCrimeAndCapsAtThreeStars()
        {
            GameObject gameObject = new GameObject("Wanted Test");
            IntEventChannel channel = ScriptableObject.CreateInstance<IntEventChannel>();
            WantedSystem wanted = gameObject.AddComponent<WantedSystem>();
            int observedLevel = -1;
            channel.Raised += level => observedLevel = level;
            wanted.Configure(channel);

            wanted.ReportCrime(CrimeType.AttackCivilian);
            wanted.ReportCrime(CrimeType.AttackGuard);
            wanted.ReportCrime(CrimeType.AttackGuard);

            Assert.That(wanted.Level, Is.EqualTo(3));
            Assert.That(observedLevel, Is.EqualTo(3));
            Object.DestroyImmediate(gameObject);
            Object.DestroyImmediate(channel);
        }

        [Test]
        public void EchoContainer_ProvidesFourSlotsAndSelection()
        {
            GameObject gameObject = new GameObject("Echo Test");
            EchoContainer container = gameObject.AddComponent<EchoContainer>();
            TemporalSlowEcho echo = ScriptableObject.CreateInstance<TemporalSlowEcho>();
            echo.Configure("slow", "时序迟滞", 1f);

            container.Equip(3, echo);
            container.SelectSlot(3);

            Assert.That(EchoContainer.MaximumSlots, Is.EqualTo(4));
            Assert.That(container.SelectedSlot, Is.EqualTo(3));
            Assert.That(container.GetEquippedIds()[3], Is.EqualTo("slow"));
            Object.DestroyImmediate(gameObject);
            Object.DestroyImmediate(echo);
        }

        [Test]
        public void CrownPlains_ActivatesNineChunksAroundPlayer()
        {
            GameObject root = new GameObject("World Test");
            GameObject player = new GameObject("Player Test");
            IReadOnlyList<WorldChunk> chunks = CrownPlainsBuilder.Build(root.transform);
            WorldStreamer streamer = root.AddComponent<WorldStreamer>();

            streamer.Configure(player.transform, CrownPlainsBuilder.ChunkSize, chunks);

            Assert.That(chunks.Count, Is.EqualTo(25));
            Assert.That(streamer.ActiveChunkCount, Is.EqualTo(9));
            Object.DestroyImmediate(root);
            Object.DestroyImmediate(player);
        }

        [Test]
        public void SaveData_RoundTripsRequiredFieldsAsJson()
        {
            SaveData original = new SaveData
            {
                playerX = 4f,
                playerY = -2f,
                playerHealth = 6f,
                equippedEchoIds = new[] { "slow", "blink", "scan", string.Empty },
                selectedEchoSlot = 2,
                wantedLevel = 3
            };

            SaveData restored = JsonUtility.FromJson<SaveData>(JsonUtility.ToJson(original));

            Assert.That(restored.playerX, Is.EqualTo(4f));
            Assert.That(restored.playerHealth, Is.EqualTo(6f));
            Assert.That(restored.equippedEchoIds[2], Is.EqualTo("scan"));
            Assert.That(restored.wantedLevel, Is.EqualTo(3));
        }
    }
}
