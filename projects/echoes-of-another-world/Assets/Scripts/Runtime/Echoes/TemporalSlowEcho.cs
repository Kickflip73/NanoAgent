using EchoesOfAnotherWorld.Runtime.Actors;
using UnityEngine;

namespace EchoesOfAnotherWorld.Runtime.Echoes
{
    [CreateAssetMenu(menuName = "异界残响/残响/时序迟滞")]
    public sealed class TemporalSlowEcho : EchoMark
    {
        public override bool Activate(EchoContext context)
        {
            Collider2D[] hits = Physics2D.OverlapCircleAll(context.User.position, 6f);
            foreach (Collider2D hit in hits)
            {
                BasicEnemy enemy = hit.GetComponentInParent<BasicEnemy>();
                if (enemy != null)
                {
                    enemy.ApplySlow(0.35f, 3f);
                }
            }

            return true;
        }
    }
}
