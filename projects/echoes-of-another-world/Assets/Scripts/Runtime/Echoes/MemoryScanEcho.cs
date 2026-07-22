using System.Collections;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Echoes
{
    [CreateAssetMenu(menuName = "异界残响/残响/记忆扫描")]
    public sealed class MemoryScanEcho : EchoMark
    {
        public override bool Activate(EchoContext context)
        {
            Collider2D[] hits = Physics2D.OverlapCircleAll(context.User.position, 7f);
            foreach (Collider2D hit in hits)
            {
                if (!hit.CompareTag("NPC") && !hit.CompareTag("Guard"))
                {
                    continue;
                }

                SpriteRenderer renderer = hit.GetComponent<SpriteRenderer>();
                if (renderer != null)
                {
                    context.Runner.StartCoroutine(Highlight(renderer));
                }
            }

            return true;
        }

        private static IEnumerator Highlight(SpriteRenderer renderer)
        {
            Color original = renderer.color;
            renderer.color = new Color(0.35f, 0.95f, 1f);
            yield return new WaitForSeconds(2f);
            if (renderer != null)
            {
                renderer.color = original;
            }
        }
    }
}
