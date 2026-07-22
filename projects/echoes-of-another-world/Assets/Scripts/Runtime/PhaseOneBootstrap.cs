using System.Collections.Generic;
using EchoesOfAnotherWorld.Runtime.Actors;
using EchoesOfAnotherWorld.Runtime.Dialogue;
using EchoesOfAnotherWorld.Runtime.Echoes;
using EchoesOfAnotherWorld.Runtime.Events;
using EchoesOfAnotherWorld.Runtime.Input;
using EchoesOfAnotherWorld.Runtime.Save;
using EchoesOfAnotherWorld.Runtime.UI;
using EchoesOfAnotherWorld.Runtime.Wanted;
using EchoesOfAnotherWorld.Runtime.World;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime
{
    public sealed class PhaseOneBootstrap : MonoBehaviour
    {
        private Sprite actorSprite;
        private WantedSystem wantedSystem;
        private FloatEventChannel healthChanged;
        private IntEventChannel wantedChanged;
        private StringEventChannel statusChanged;
        private StringEventChannel dialogueChanged;

        private void Awake()
        {
            CreateEventChannels();
            actorSprite = CreateActorSprite();

            GameObject systems = new GameObject("P1 系统");
            systems.transform.SetParent(transform, false);
            wantedSystem = systems.AddComponent<WantedSystem>();
            wantedSystem.Configure(wantedChanged);

            GameObject player = CreatePlayer();
            IReadOnlyList<WorldChunk> chunks = CrownPlainsBuilder.Build(transform);
            WorldStreamer streamer = systems.AddComponent<WorldStreamer>();
            streamer.Configure(player.transform, CrownPlainsBuilder.ChunkSize, chunks);

            CreateCamera(player.transform);
            CreateEnemies(player.transform);
            CreateTown(player, systems);

            EchoMark[] echoes = CreateEchoes(player.GetComponent<EchoContainer>());
            ActorHealth playerHealth = player.GetComponent<ActorHealth>();
            GameHud hud = new GameObject("基础 UI").AddComponent<GameHud>();
            hud.transform.SetParent(transform, false);
            hud.Configure(
                healthChanged,
                wantedChanged,
                statusChanged,
                dialogueChanged,
                player.GetComponent<EchoContainer>(),
                playerHealth.CurrentHealth / playerHealth.MaximumHealth);

            GuardSpawner guardSpawner = systems.AddComponent<GuardSpawner>();
            guardSpawner.Configure(player.transform, actorSprite, wantedSystem, wantedChanged);

            JsonSaveSystem saveSystem = systems.AddComponent<JsonSaveSystem>();
            saveSystem.Configure(
                player.transform,
                playerHealth,
                player.GetComponent<EchoContainer>(),
                wantedSystem,
                echoes);

            statusChanged.Raise("欢迎来到王冠平原。城镇居民就在道路附近。按 E 发动时序迟滞。 ");
        }

        private void CreateEventChannels()
        {
            healthChanged = ScriptableObject.CreateInstance<FloatEventChannel>();
            healthChanged.name = "玩家生命事件";
            wantedChanged = ScriptableObject.CreateInstance<IntEventChannel>();
            wantedChanged.name = "通缉等级事件";
            statusChanged = ScriptableObject.CreateInstance<StringEventChannel>();
            statusChanged.name = "状态提示事件";
            dialogueChanged = ScriptableObject.CreateInstance<StringEventChannel>();
            dialogueChanged.name = "对话事件";
        }

        private GameObject CreatePlayer()
        {
            GameObject player = new GameObject("玩家");
            player.transform.SetParent(transform, false);
            player.transform.position = new Vector3(1f, 2f, 0f);
            player.tag = "Player";
            player.layer = LayerMask.NameToLayer("Player");

            SpriteRenderer renderer = player.AddComponent<SpriteRenderer>();
            renderer.sprite = actorSprite;
            renderer.color = new Color(0.25f, 0.8f, 0.95f);
            renderer.sortingLayerName = "Actors";
            CircleCollider2D collider = player.AddComponent<CircleCollider2D>();
            collider.radius = 0.42f;
            Rigidbody2D body = player.AddComponent<Rigidbody2D>();
            body.gravityScale = 0f;
            body.freezeRotation = true;
            body.collisionDetectionMode = CollisionDetectionMode2D.Continuous;

            player.AddComponent<PlayerInput>();
            player.AddComponent<CombatSystem>();
            player.AddComponent<DodgeSystem>();
            EchoContainer echoContainer = player.AddComponent<EchoContainer>();
            echoContainer.Configure(statusChanged);
            ActorHealth health = player.AddComponent<ActorHealth>();
            health.Configure(8f, ActorDisposition.Player, false, healthChanged);
            player.AddComponent<PlayerController>();
            return player;
        }

        private void CreateCamera(Transform player)
        {
            GameObject cameraObject = new GameObject("Main Camera");
            cameraObject.tag = "MainCamera";
            Camera camera = cameraObject.AddComponent<Camera>();
            camera.orthographic = true;
            camera.orthographicSize = 10f;
            camera.backgroundColor = new Color(0.12f, 0.18f, 0.12f);
            cameraObject.AddComponent<AudioListener>();
            cameraObject.AddComponent<CameraFollow>().Configure(player);
        }

        private void CreateEnemies(Transform player)
        {
            Transform enemyRoot = new GameObject("平原敌人").transform;
            enemyRoot.SetParent(transform, false);
            Vector2[] positions =
            {
                new Vector2(-5f, 3f),
                new Vector2(-8f, -5f),
                new Vector2(12f, -3f),
                new Vector2(18f, 4f),
                new Vector2(5f, 16f)
            };
            for (int index = 0; index < positions.Length; index++)
            {
                CreateEnemy(enemyRoot, player, positions[index], index);
            }
        }

        private void CreateEnemy(Transform parent, Transform player, Vector2 position, int index)
        {
            GameObject enemy = new GameObject($"史莱姆 {index + 1}");
            enemy.transform.SetParent(parent, false);
            enemy.transform.position = position;
            SpriteRenderer renderer = enemy.AddComponent<SpriteRenderer>();
            renderer.sprite = actorSprite;
            renderer.color = new Color(0.4f, 0.85f, 0.3f);
            renderer.sortingLayerName = "Actors";
            enemy.AddComponent<CircleCollider2D>().radius = 0.43f;
            Rigidbody2D body = enemy.AddComponent<Rigidbody2D>();
            body.gravityScale = 0f;
            body.freezeRotation = true;
            ActorHealth health = enemy.AddComponent<ActorHealth>();
            health.Configure(3f, ActorDisposition.Hostile, true);
            BasicEnemy basicEnemy = enemy.AddComponent<BasicEnemy>();
            basicEnemy.Configure(player);
        }

        private void CreateTown(GameObject player, GameObject systems)
        {
            Transform town = new GameObject("晨钟镇").transform;
            town.SetParent(transform, false);
            CreateNpc(town, "面包师莉亚", new Vector2(2f, 2f), false,
                "清晨的麦香能让人暂时忘记裂隙。", "沿着土路向西，小心那些史莱姆。");
            CreateNpc(town, "老兵罗德", new Vector2(8f, 2f), false,
                "你不是本地人。握剑的姿势倒还算稳。", "攻击镇民会招来王国守卫，别说我没提醒你。");
            CreateNpc(town, "学者米娅", new Vector2(2f, 8f), false,
                "你身上的蓝光……那是残响印记吗？", "按 Q 可以切换容器中的印记，E 会释放当前印记。");
            CreateNpc(town, "商人贝洛", new Vector2(8f, 8f), true,
                "旅行者，补给、传闻和旧地图，我这里都有。", "P1 演示期间货箱还没送到，但欢迎随时来聊聊。");
            CreateTownGuard(town, new Vector2(1f, 5f));

            DialogueSystem dialogueSystem = systems.AddComponent<DialogueSystem>();
            dialogueSystem.Configure(
                player.GetComponent<PlayerInput>(),
                player.transform,
                dialogueChanged);
        }

        private void CreateNpc(
            Transform parent,
            string npcName,
            Vector2 position,
            bool merchant,
            params string[] lines)
        {
            GameObject npc = CreateActorObject(parent, npcName, position, "NPC", new Color(0.95f, 0.72f, 0.3f));
            ActorHealth health = npc.AddComponent<ActorHealth>();
            health.Configure(2f, ActorDisposition.Civilian, true, null, wantedSystem);
            DialogueNpc dialogueNpc = npc.AddComponent<DialogueNpc>();
            dialogueNpc.Configure(CreateDialogueTree(npcName, lines), merchant);
        }

        private void CreateTownGuard(Transform parent, Vector2 position)
        {
            GameObject guard = CreateActorObject(parent, "城门守卫", position, "Guard", new Color(0.3f, 0.4f, 0.85f));
            ActorHealth health = guard.AddComponent<ActorHealth>();
            health.Configure(5f, ActorDisposition.Guard, true, null, wantedSystem);
            DialogueNpc dialogueNpc = guard.AddComponent<DialogueNpc>();
            dialogueNpc.Configure(CreateDialogueTree("城门守卫", "欢迎来到晨钟镇。请遵守王国律法。"), false);
        }

        private GameObject CreateActorObject(
            Transform parent,
            string actorName,
            Vector2 position,
            string actorTag,
            Color color)
        {
            GameObject actor = new GameObject(actorName);
            actor.transform.SetParent(parent, false);
            actor.transform.position = position;
            actor.tag = actorTag;
            SpriteRenderer renderer = actor.AddComponent<SpriteRenderer>();
            renderer.sprite = actorSprite;
            renderer.color = color;
            renderer.sortingLayerName = "Actors";
            actor.AddComponent<CircleCollider2D>().radius = 0.42f;
            return actor;
        }

        private static DialogueTree CreateDialogueTree(string speaker, params string[] lines)
        {
            DialogueNode[] nodes = new DialogueNode[lines.Length];
            for (int index = 0; index < lines.Length; index++)
            {
                DialogueNode node = ScriptableObject.CreateInstance<DialogueNode>();
                node.name = $"{speaker} 对话 {index + 1}";
                node.Configure(speaker, lines[index]);
                nodes[index] = node;
            }

            DialogueTree tree = ScriptableObject.CreateInstance<DialogueTree>();
            tree.name = $"{speaker} 对话树";
            tree.Configure(nodes);
            return tree;
        }

        private static EchoMark[] CreateEchoes(EchoContainer container)
        {
            TemporalSlowEcho temporal = ScriptableObject.CreateInstance<TemporalSlowEcho>();
            temporal.name = "时序迟滞";
            temporal.Configure("temporal-slow", "时序迟滞", 4f);
            SpatialBlinkEcho spatial = ScriptableObject.CreateInstance<SpatialBlinkEcho>();
            spatial.name = "空间闪现";
            spatial.Configure("spatial-blink", "空间闪现", 2f);
            MemoryScanEcho memory = ScriptableObject.CreateInstance<MemoryScanEcho>();
            memory.name = "记忆扫描";
            memory.Configure("memory-scan", "记忆扫描", 3f);

            EchoMark[] echoes = { temporal, spatial, memory };
            for (int index = 0; index < echoes.Length; index++)
            {
                container.Equip(index, echoes[index]);
            }

            container.SelectSlot(0);
            return echoes;
        }

        private static Sprite CreateActorSprite()
        {
            const int size = 16;
            Texture2D texture = new Texture2D(size, size, TextureFormat.RGBA32, false);
            texture.name = "Runtime Actor Texture";
            texture.filterMode = FilterMode.Point;
            Color[] pixels = new Color[size * size];
            for (int y = 0; y < size; y++)
            {
                for (int x = 0; x < size; x++)
                {
                    bool corner = (x < 2 || x > size - 3) && (y < 2 || y > size - 3);
                    pixels[y * size + x] = corner ? Color.clear : Color.white;
                }
            }

            texture.SetPixels(pixels);
            texture.Apply();
            return Sprite.Create(texture, new Rect(0f, 0f, size, size), new Vector2(0.5f, 0.5f), 16f);
        }
    }
}
