using System.Collections.Generic;
using EchoesOfAnotherWorld.Runtime.Actors;
using EchoesOfAnotherWorld.Runtime.Events;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Wanted
{
    public sealed class GuardSpawner : MonoBehaviour
    {
        private readonly List<GameObject> activeGuards = new List<GameObject>();
        private IntEventChannel wantedLevelChanged;
        private Transform player;
        private Sprite actorSprite;
        private WantedSystem wantedSystem;

        public void Configure(
            Transform playerTransform,
            Sprite sprite,
            WantedSystem wanted,
            IntEventChannel changedChannel)
        {
            player = playerTransform;
            actorSprite = sprite;
            wantedSystem = wanted;
            wantedLevelChanged = changedChannel;
            wantedLevelChanged.Raised += OnWantedLevelChanged;
        }

        private void OnDestroy()
        {
            if (wantedLevelChanged != null)
            {
                wantedLevelChanged.Raised -= OnWantedLevelChanged;
            }
        }

        private void OnWantedLevelChanged(int level)
        {
            activeGuards.RemoveAll(guard => guard == null);
            while (activeGuards.Count < level)
            {
                activeGuards.Add(CreateGuard(activeGuards.Count));
            }
        }

        private GameObject CreateGuard(int index)
        {
            Vector2 offset = Quaternion.Euler(0f, 0f, index * 120f) * Vector2.right * 6f;
            GameObject guard = new GameObject($"追捕守卫 {index + 1}");
            guard.tag = "Guard";
            guard.transform.position = (Vector2)player.position + offset;

            SpriteRenderer renderer = guard.AddComponent<SpriteRenderer>();
            renderer.sprite = actorSprite;
            renderer.color = new Color(0.25f, 0.35f, 0.8f);
            renderer.sortingLayerName = "Actors";
            guard.AddComponent<CircleCollider2D>().radius = 0.45f;
            Rigidbody2D body = guard.AddComponent<Rigidbody2D>();
            body.gravityScale = 0f;
            body.freezeRotation = true;

            ActorHealth health = guard.AddComponent<ActorHealth>();
            health.Configure(4f, ActorDisposition.Guard, true, null, wantedSystem);
            BasicEnemy enemy = guard.AddComponent<BasicEnemy>();
            enemy.Configure(player, 30f);
            return guard;
        }
    }
}
